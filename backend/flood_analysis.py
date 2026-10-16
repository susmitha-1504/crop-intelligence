import numpy as np
import planetary_computer
import rasterio

from pystac_client import Client
from rasterio.enums import Resampling
from rasterio.features import geometry_mask, geometry_window, shapes
from rasterio.vrt import WarpedVRT
from rasterio.warp import transform_geom
from shapely.geometry import mapping, shape
from pyproj import Geod


STAC_URL = "https://planetarycomputer.microsoft.com/api/stac/v1"
GEOD = Geod(ellps="WGS84")


def _area_m2(geometry):
    """Geodesic area for a GeoJSON geometry in longitude/latitude."""
    geom = shape(geometry)
    if geom.is_empty:
        return 0.0
    area, _ = GEOD.geometry_area_perimeter(geom)
    return abs(float(area))


def get_water_mask(item_id: str, farm_geometry: dict) -> dict:
    """Calculate a preliminary water mask for one Sentinel-2 scene."""

    catalog = Client.open(STAC_URL)
    items = list(
        catalog.search(
            collections=["sentinel-2-l2a"],
            ids=[item_id],
            limit=1,
        ).items()
    )

    if not items:
        raise ValueError(f"Satellite scene not found: {item_id}")

    item = planetary_computer.sign(items[0])
    farm = shape(farm_geometry)

    if farm.is_empty or not farm.is_valid:
        raise ValueError("Farm boundary is empty or invalid.")

    assets = item.assets
    for name in ("B03", "B11", "SCL"):
        if name not in assets:
            raise ValueError(f"Required satellite band missing: {name}")

    with rasterio.open(assets["B11"].href) as swir_src:
        farm_projected = transform_geom(
            "EPSG:4326", swir_src.crs, mapping(farm)
        )

        try:
            window = geometry_window(swir_src, [farm_projected])
        except Exception as error:
            raise ValueError(
                "The farm boundary does not overlap this satellite scene."
            ) from error

        window = window.round_offsets().round_lengths()
        swir = swir_src.read(1, window=window).astype(np.float32)
        grid_transform = swir_src.window_transform(window)
        grid_crs = swir_src.crs

        with rasterio.open(assets["B03"].href) as green_src:
            with WarpedVRT(
                green_src,
                crs=grid_crs,
                transform=swir_src.transform,
                width=swir_src.width,
                height=swir_src.height,
                resampling=Resampling.average,
            ) as green_vrt:
                green = green_vrt.read(1, window=window).astype(np.float32)

        with rasterio.open(assets["SCL"].href) as scl_src:
            with WarpedVRT(
                scl_src,
                crs=grid_crs,
                transform=swir_src.transform,
                width=swir_src.width,
                height=swir_src.height,
                resampling=Resampling.nearest,
            ) as scl_vrt:
                scl = scl_vrt.read(1, window=window)

        inside_farm = geometry_mask(
            [farm_projected],
            out_shape=swir.shape,
            transform=grid_transform,
            invert=True,
        )

        pixel_area_m2 = abs(
            grid_transform.a * grid_transform.e
            - grid_transform.b * grid_transform.d
        )
        print("RASTER CRS:", grid_crs)
        print("PIXEL AREA:", pixel_area_m2, "m²")
        print("RASTER RESOLUTION:", swir_src.res)

    # Exclude no-data, saturated, cloud-shadow, cloud, cirrus and snow pixels.
    valid = (
        inside_farm
        & (scl != 0)
        & (scl != 1)
        & (scl != 3)
        & (scl != 8)
        & (scl != 9)
        & (scl != 10)
        & (scl != 11)
        & np.isfinite(green)
        & np.isfinite(swir)
        & ((green + swir) != 0)
    )

    mndwi = np.full(swir.shape, np.nan, dtype=np.float32)
    mndwi[valid] = (
        (green[valid] - swir[valid])
        / (green[valid] + swir[valid])
    )

    # Preliminary screening threshold; local validation is required.
    water = valid & (mndwi > 0.0)

    return {
        "scene_id": item.id,
        "date": item.datetime.isoformat() if item.datetime else None,
        "water_mask": water,
        "valid_mask": valid,
        "pixel_area_m2": pixel_area_m2,
        "transform": grid_transform,
        "crs": grid_crs,
        "valid_pixels": int(valid.sum()),
        "water_pixels": int(water.sum()),
    }


def compare_flood_scenes(
    before_item_id: str,
    after_item_id: str,
    farm_geometry: dict,
) -> dict:
    """Compare candidate water before and after an event and return area estimates."""

    before = get_water_mask(before_item_id, farm_geometry)
    after = get_water_mask(after_item_id, farm_geometry)

    # Matching array shapes alone is not sufficient: both rasters must use
    # the same pixel grid to compare corresponding pixels safely.
    if (
        before["water_mask"].shape != after["water_mask"].shape
        or before["transform"] != after["transform"]
        or before["crs"] != after["crs"]
    ):
        raise ValueError(
            "The two images do not share the same analysis grid. "
            "Choose scenes from the same Sentinel-2 tile and grid."
        )

    common_valid = before["valid_mask"] & after["valid_mask"]
    common_valid_pixels = int(common_valid.sum())

    if common_valid_pixels == 0:
     raise ValueError(
        "No comparable valid pixels. Try different dates "
        "or another satellite scene."
    )
    newly_detected_water = (
        common_valid
        & ~before["water_mask"]
        & after["water_mask"]
    )

    pixel_area = float(after["pixel_area_m2"])
    before_water = common_valid & before["water_mask"]
    after_water = common_valid & after["water_mask"]

    farm_area_m2 = _area_m2(farm_geometry)
    newly_detected_area_m2 = int(newly_detected_water.sum()) * pixel_area
    newly_detected_area_ha = newly_detected_area_m2 / 10000.0
    newly_detected_area_acres = newly_detected_area_m2 / 4046.8564224

    # Convert detected raster pixels into GeoJSON polygons for a map overlay.
    # Tiny isolated detections are omitted from the overlay to reduce noise;
    # the reported pixel-area total still includes every detected pixel.
    overlay_features = []
    minimum_overlay_pixels = 3
    for geom, value in shapes(
        newly_detected_water.astype(np.uint8),
        mask=newly_detected_water,
        transform=after["transform"],
    ):
        if not value:
            continue
        projected_polygon = shape(geom)
        if projected_polygon.area < pixel_area * minimum_overlay_pixels:
            continue
        geographic_polygon = transform_geom(
            after["crs"],
            "EPSG:4326",
            mapping(projected_polygon),
        )
        overlay_features.append({
            "type": "Feature",
            "geometry": geographic_polygon,
            "properties": {"type": "candidate_new_water"},
        })

    # Keep responses practical if the mask contains many small polygons.
    # Largest polygons are retained for display; total area metrics use all pixels.
    overlay_features.sort(
        key=lambda feature: _area_m2(feature["geometry"]),
        reverse=True,
    )
    overlay_features = overlay_features[:300]

    common_valid_area_m2 = int(common_valid.sum()) * pixel_area
    return {
        "before_scene_id": before["scene_id"],
        "before_date": before["date"],
        "after_scene_id": after["scene_id"],
        "after_date": after["date"],
        "farm_area_m2": round(farm_area_m2, 2),
        "farm_area_hectares": round(farm_area_m2 / 10000.0, 4),
        "farm_area_acres": round(farm_area_m2 / 4046.8564224, 4),
        "common_valid_pixels": int(common_valid.sum()),
        "common_valid_area_m2": round(common_valid_area_m2, 2),
        "common_valid_coverage_percent": round(
            min(100.0, common_valid_area_m2 / farm_area_m2 * 100.0)
            if farm_area_m2 > 0 else 0.0,
            2,
        ),
        "before_water_area_m2": round(int(before_water.sum()) * pixel_area, 2),
        "after_water_area_m2": round(int(after_water.sum()) * pixel_area, 2),
        "newly_detected_water_pixels": int(newly_detected_water.sum()),
        "newly_detected_water_area_m2": round(newly_detected_area_m2, 2),
        "newly_detected_water_area_hectares": round(newly_detected_area_ha, 4),
        "newly_detected_water_area_acres": round(newly_detected_area_acres, 4),
        "newly_detected_water_percent_of_farm": round(
            min(100.0, newly_detected_area_m2 / farm_area_m2 * 100.0)
            if farm_area_m2 > 0 else 0.0,
            2,
        ),
        "candidate_water_geojson": {
            "type": "FeatureCollection",
            "features": overlay_features,
        },
        "method": (
            "Preliminary MNDWI screening with threshold > 0.0; "
            "new water means non-water before and water after. "
            "Overlay omits detections smaller than three pixels and is capped "
            "at 300 polygons; area metrics use all detected pixels."
        ),
        "warning": (
            "Newly detected water is not confirmed flood or crop damage. "
            "Seasonal water, wet soil, clouds, and image differences can affect "
            "the result. The valid-pixel coverage percentage indicates how much "
            "of the farm could be compared after masking invalid pixels. Review "
            "the imagery and validate affected regions manually."
        ),
    }
