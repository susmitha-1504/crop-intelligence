
from datetime import date

from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
from pystac_client import Client
from flood_analysis import compare_flood_scenes
import planetary_computer

app = FastAPI(title="Crop Intelligence Satellite API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=[],
    allow_origin_regex=r"https?://(localhost|127\.0\.0\.1)(:\d+)?",
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

STAC_URL = "https://planetarycomputer.microsoft.com/api/stac/v1"


@app.get("/")
def home():
    return {
        "message": "Crop Intelligence Satellite API is running"
    }


def get_catalog():
    return Client.open(STAC_URL)


def search_scenes(
    intersects: dict,
    start_date: date,
    end_date: date,
    max_items: int = 10,
):
    if start_date > end_date:
        raise HTTPException(
            status_code=400,
            detail="Start date must be before or equal to end date.",
        )

    catalog = get_catalog()

    search = catalog.search(
        collections=["sentinel-2-l2a"],
        intersects=intersects,
        datetime=(
            f"{start_date.isoformat()}T00:00:00Z/"
            f"{end_date.isoformat()}T23:59:59Z"
        ),
        max_items=max_items,
        query={"eo:cloud_cover": {"lt": 30}},
    )

    items = list(search.items())
    items.sort(
        key=lambda item: item.datetime or "",
        reverse=True,
    )

    images = []

    for item in items:
        signed_item = planetary_computer.sign(item)
        assets = signed_item.assets

        images.append({
            "id": item.id,
            "date": (
                item.datetime.isoformat()
                if item.datetime else None
            ),
            "cloud_cover": item.properties.get(
                "eo:cloud_cover"
            ),
            "preview_url": (
                assets["rendered_preview"].href
                if "rendered_preview" in assets
                else None
            ),
            "visual_asset_available": "visual" in assets,
            "available_bands": [
                band for band in ["B03", "B04", "B08", "B11", "B12", "SCL"]
                if band in assets
            ],
        })

    return images


@app.get("/api/satellite-search")
def satellite_search(
    lat: float = 12.6819,
    lon: float = 78.6200,
    start_date: date = Query(default=date(2025, 1, 1)),
    end_date: date = Query(default=date(2025, 12, 31)),
):
    if not -90 <= lat <= 90 or not -180 <= lon <= 180:
        raise HTTPException(
            status_code=400,
            detail="Invalid latitude or longitude.",
        )

    try:
        images = search_scenes(
            intersects={
                "type": "Point",
                "coordinates": [lon, lat],
            },
            start_date=start_date,
            end_date=end_date,
        )

        return {
            "count": len(images),
            "images": images,
        }

    except HTTPException:
        raise
    except Exception as error:
        raise HTTPException(
            status_code=502,
            detail=f"Satellite catalog request failed: {error}",
        )


class BeforeAfterRequest(BaseModel):
    farm_boundary: dict
    before_start: date
    before_end: date
    after_start: date
    after_end: date
    max_items: int = Field(default=10, ge=1, le=30)


@app.post("/api/before-after-search")
def before_after_search(request: BeforeAfterRequest):
    boundary = request.farm_boundary

    if boundary.get("type") != "Feature":
        raise HTTPException(
            status_code=400,
            detail="Farm boundary must be a GeoJSON Feature.",
        )

    geometry = boundary.get("geometry")

    if not geometry or geometry.get("type") not in (
        "Polygon",
        "MultiPolygon",
    ):
        raise HTTPException(
            status_code=400,
            detail="Farm boundary must contain a Polygon or MultiPolygon.",
        )

    if request.before_start > request.before_end:
        raise HTTPException(
            status_code=400,
            detail="Invalid before-disaster date range.",
        )

    if request.after_start > request.after_end:
        raise HTTPException(
            status_code=400,
            detail="Invalid after-disaster date range.",
        )

    if request.before_end >= request.after_start:
        raise HTTPException(
            status_code=400,
            detail="The before period must end before the after period begins.",
        )

    try:
        before_images = search_scenes(
            intersects=geometry,
            start_date=request.before_start,
            end_date=request.before_end,
            max_items=request.max_items,
        )

        after_images = search_scenes(
            intersects=geometry,
            start_date=request.after_start,
            end_date=request.after_end,
            max_items=request.max_items,
        )

        return {
            "before": {
                "count": len(before_images),
                "images": before_images,
            },
            "after": {
                "count": len(after_images),
                "images": after_images,
            },
            "message": (
                "No suitable scenes found for one or both periods. "
                "Try wider date ranges or different dates."
                if not before_images or not after_images
                else "Satellite scenes retrieved. "
                     "Choose suitable images for comparison."
            ),
        }

    except HTTPException:
        raise
    except Exception as error:
        raise HTTPException(
            status_code=502,
            detail=f"Before/after satellite search failed: {error}",
        )

@app.post("/api/flood-water-analysis")
def flood_water_analysis(request: BeforeAfterRequest):
    try:
        # Search for images from before the event.
        before_scenes = search_scenes(
            intersects=request.farm_boundary["geometry"],
            start_date=request.before_start,
            end_date=request.before_end,
            max_items=request.max_items,
        )

        # Search for images from after the event.
        after_scenes = search_scenes(
            intersects=request.farm_boundary["geometry"],
            start_date=request.after_start,
            end_date=request.after_end,
            max_items=request.max_items,
        )

        if not before_scenes:
            raise HTTPException(
                status_code=404,
                detail="No suitable before-period satellite scenes found.",
            )

        if not after_scenes:
            raise HTTPException(
                status_code=404,
                detail="No suitable after-period satellite scenes found.",
            )

        # Try matching scenes from the same Sentinel-2 tile.
        before_by_tile = {
            scene["id"].split("_T")[-1][:5]: scene
            for scene in before_scenes
            if "_T" in scene["id"]
        }

        matching_pair = None

        for after_scene in after_scenes:
            tile = (
                after_scene["id"].split("_T")[-1][:5]
                if "_T" in after_scene["id"]
                else None
            )

            if tile in before_by_tile:
                matching_pair = (
                    before_by_tile[tile],
                    after_scene,
                )
                break

        if matching_pair is None:
            raise HTTPException(
                status_code=422,
                detail=(
                    "No matching Sentinel-2 tile was found in both "
                    "date ranges. Try different date ranges."
                ),
            )

        before_scene, after_scene = matching_pair

        result = compare_flood_scenes(
            before_item_id=before_scene["id"],
            after_item_id=after_scene["id"],
            farm_geometry=request.farm_boundary["geometry"],
        )

        return {
            "analysis": result,
            "message": (
                "Before-and-after water comparison completed. "
                "Results indicate candidate new water, not confirmed "
                "flood damage."
            ),
        }

    except HTTPException:
        raise
    except Exception as error:
        raise HTTPException(
            status_code=502,
            detail=f"Flood comparison failed: {error}",
        )
