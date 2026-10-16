import { useCallback, useEffect, useRef } from "react";
import { MapContainer, TileLayer, useMap } from "react-leaflet";

import "@geoman-io/leaflet-geoman-free";
import "@geoman-io/leaflet-geoman-free/dist/leaflet-geoman.css";

import L from "leaflet";
import booleanWithin from "@turf/boolean-within";
import booleanIntersects from "@turf/boolean-intersects";
import booleanPointInPolygon from "@turf/boolean-point-in-polygon";
import { point } from "@turf/helpers";

function isRegionInsideFarm(region, farm) {
  return booleanWithin(region, farm);
}

function regionsOverlap(first, second) {
  return booleanIntersects(first, second);
}

function DrawingTools({ onBoundaryChange }) {
  const map = useMap();

  const drawnLayers = useRef(new Set());
  const drawingMode = useRef("farm");
  const deleteMode = useRef(false);

  const freehandMode = useRef(false);
  const freehandPoints = useRef([]);
  const freehandPreview = useRef(null);
  const freehandStartPoint = useRef(null);

  const publishBoundary = useCallback(() => {
    const features = Array.from(drawnLayers.current)
      .filter((layer) => map.hasLayer(layer))
      .map((layer) => {
        const feature = layer.toGeoJSON();
        feature.properties = {
          ...(feature.properties || {}),
          role: layer.featureType,
        };
        return feature;
      });

    onBoundaryChange({ type: "FeatureCollection", features });
  }, [map, onBoundaryChange]);

  useEffect(() => {
    const mapContainer = map.getContainer();

    const getFarmLayer = () =>
      Array.from(drawnLayers.current).find(
        (layer) => map.hasLayer(layer) && layer.featureType === "farm"
      );

    const removePreview = () => {
      if (freehandPreview.current) {
        map.removeLayer(freehandPreview.current);
        freehandPreview.current = null;
      }
    };

    const cancelFreehand = () => {
      freehandMode.current = false;
      freehandStartPoint.current = null;
      freehandPoints.current = [];
      removePreview();
      if (map.dragging) map.dragging.enable();
      mapContainer.style.cursor = "";
    };

    const handleCreate = (event) => {
      const layer = event.layer;
      if (!(layer instanceof L.Polygon)) return;

      const mode = drawingMode.current;
      const feature = layer.toGeoJSON();

      if (mode === "farm" && getFarmLayer()) {
        if (map.hasLayer(layer)) map.removeLayer(layer);
        alert("A farm boundary already exists. Delete it before drawing another.");
        return;
      }

      if (mode !== "farm") {
        const farmLayer = getFarmLayer();

        if (!farmLayer) {
          if (map.hasLayer(layer)) map.removeLayer(layer);
          alert("Draw the farm boundary first.");
          return;
        }

        if (!isRegionInsideFarm(feature, farmLayer.toGeoJSON())) {
          if (map.hasLayer(layer)) map.removeLayer(layer);
          alert("The entire region must be inside the farm boundary.");
          return;
        }

        const conflict = Array.from(drawnLayers.current).some((existing) => {
          if (!map.hasLayer(existing)) return false;
          if (
            existing.featureType !== "damaged" &&
            existing.featureType !== "nonDamaged"
          ) {
            return false;
          }
          return regionsOverlap(feature, existing.toGeoJSON());
        });

        if (conflict) {
          if (map.hasLayer(layer)) map.removeLayer(layer);
          alert("This region overlaps an existing damaged or non-damaged region.");
          return;
        }
      }

      layer.featureType = mode;

      const styles = {
        farm: {
          color: "#f5c542",
          fillColor: "#f5c542",
          fillOpacity: 0.08,
          weight: 3,
        },
        damaged: {
          color: "#e53935",
          fillColor: "#e53935",
          fillOpacity: 0.45,
          weight: 2,
        },
        nonDamaged: {
          color: "#2eaf65",
          fillColor: "#2eaf65",
          fillOpacity: 0.4,
          weight: 2,
        },
      };

      layer.setStyle(styles[mode]);
      if (!map.hasLayer(layer)) layer.addTo(map);
      drawnLayers.current.add(layer);
      layer.on("pm:edit", publishBoundary);
      publishBoundary();
    };

    const getLatLngFromMouseEvent = (event) => {
      const rect = mapContainer.getBoundingClientRect();
      const containerPoint = L.point(
        event.clientX - rect.left,
        event.clientY - rect.top
      );
      return map.containerPointToLatLng(containerPoint);
    };

    // Native DOM events are used consistently for freehand drawing:
    // mousedown starts the stroke, window mousemove collects points,
    // and window mouseup finishes even if the pointer leaves the map.
    const handleFreehandMouseDown = (event) => {
      if (!freehandMode.current || event.button !== 0) return;
      if (event.target.closest?.(".custom-drawing-tools")) return;

      // Capture the gesture before Leaflet's own drag handler sees it.
      event.preventDefault();
      event.stopPropagation();
      if (typeof event.stopImmediatePropagation === "function") {
        event.stopImmediatePropagation();
      }
      if (map.dragging) map.dragging.disable();

      freehandStartPoint.current = getLatLngFromMouseEvent(event);
      freehandPoints.current = [freehandStartPoint.current];

      removePreview();

      const color =
        drawingMode.current === "damaged"
          ? "#e53935"
          : drawingMode.current === "nonDamaged"
          ? "#2eaf65"
          : "#f5c542";

      freehandPreview.current = L.polygon(freehandPoints.current, {
        color,
        fillColor: color,
        fillOpacity: 0.15,
        weight: 2,
        dashArray: "5, 5",
        interactive: false,
      }).addTo(map);

      map.dragging.disable();
    };

    const handleFreehandMouseMove = (event) => {
      if (!freehandMode.current || !freehandStartPoint.current) return;

      const latlng = getLatLngFromMouseEvent(event);
      freehandPoints.current.push(latlng);

      if (freehandPreview.current) {
        freehandPreview.current.setLatLngs(freehandPoints.current);
      }
    };

    const handleFreehandMouseUp = () => {
      if (!freehandMode.current || !freehandStartPoint.current) return;

      const points = [...freehandPoints.current];

      freehandMode.current = false;
      freehandStartPoint.current = null;
      freehandPoints.current = [];
      removePreview();

      if (map.dragging) map.dragging.enable();
      mapContainer.style.cursor = "";

      if (points.length < 3) {
        alert("Not enough drawing points were collected. Please drag the mouse while holding the left button.");
        return;
      }

      const polygon = L.polygon(points);
      polygon.featureType = drawingMode.current;
      handleCreate({ layer: polygon });
    };

    const handleMapClick = (event) => {
      if (!deleteMode.current) return;

      const clickedPoint = point([event.latlng.lng, event.latlng.lat]);
      const clickedLayer = Array.from(drawnLayers.current)
        .reverse()
        .find((layer) => {
          if (!map.hasLayer(layer)) return false;
          try {
            return booleanPointInPolygon(clickedPoint, layer.toGeoJSON());
          } catch {
            return false;
          }
        });

      if (!clickedLayer) {
        alert("Click inside the shape you want to delete.");
        return;
      }

      map.removeLayer(clickedLayer);
      drawnLayers.current.delete(clickedLayer);
      deleteMode.current = false;
      mapContainer.style.cursor = "";
      publishBoundary();
    };

    const control = L.control({ position: "topleft" });

    control.onAdd = () => {
      const container = L.DomUtil.create("div", "custom-drawing-tools");

      const createButton = (label, action) => {
        const button = L.DomUtil.create("button", "", container);
        button.type = "button";
        button.textContent = label;
        L.DomEvent.on(button, "click", (event) => {
          L.DomEvent.stop(event);
          action();
        });
      };

      const startFreehand = (mode) => {
        if (mode !== "farm" && !getFarmLayer()) {
          alert("Draw the farm boundary first.");
          return;
        }

        map.pm.disableDraw();
        map.pm.disableGlobalRemovalMode();
        cancelFreehand();

        drawingMode.current = mode;
        deleteMode.current = false;
        freehandMode.current = true;
        // Disable map panning for the entire freehand tool session so the
        // map cannot move while the user is trying to draw.
        if (map.dragging) map.dragging.disable();
        mapContainer.style.cursor = "crosshair";
      };

      const startDrawing = (mode, shape = "Polygon") => {
        cancelFreehand();
        drawingMode.current = mode;
        deleteMode.current = false;

        map.pm.disableDraw();
        map.pm.disableGlobalRemovalMode();
        mapContainer.style.cursor = "";

        map.pm.enableDraw(shape, {
          snappable: true,
          continueDrawing: false,
          templineStyle: {
            color:
              mode === "damaged"
                ? "#e53935"
                : mode === "nonDamaged"
                ? "#2eaf65"
                : "#f5c542",
          },
        });
      };

      createButton("Freehand Farm Boundary", () => startFreehand("farm"));
      createButton("Freehand Damaged Region", () => startFreehand("damaged"));
      createButton("Freehand Non-Damaged Region", () => startFreehand("nonDamaged"));

      createButton("Freehand Drawing", () => {
        startFreehand(getFarmLayer() ? drawingMode.current : "farm");
      });

      createButton("Draw Rectangle", () => {
        startDrawing(getFarmLayer() ? drawingMode.current : "farm", "Rectangle");
      });

      createButton("Draw Polygon", () => {
        startDrawing(getFarmLayer() ? drawingMode.current : "farm", "Polygon");
      });

      createButton("Delete Shape", () => {
        cancelFreehand();
        map.pm.disableDraw();
        map.pm.disableGlobalRemovalMode();
        deleteMode.current = true;
        mapContainer.style.cursor = "crosshair";
      });

      createButton("Finish / Cancel", () => {
        cancelFreehand();
        map.pm.disableDraw();
        map.pm.disableGlobalRemovalMode();
        deleteMode.current = false;
        mapContainer.style.cursor = "";
      });

      L.DomEvent.disableClickPropagation(container);
      L.DomEvent.disableScrollPropagation(container);
      return container;
    };

    control.addTo(map);

    const handlePmRemove = (event) => {
      drawnLayers.current.delete(event.layer);
      publishBoundary();
    };

    map.on("pm:create", handleCreate);
    map.on("pm:remove", handlePmRemove);
    map.on("click", handleMapClick);

    mapContainer.addEventListener("mousedown", handleFreehandMouseDown, true);
    window.addEventListener("mousemove", handleFreehandMouseMove);
    window.addEventListener("mouseup", handleFreehandMouseUp);

    return () => {
      cancelFreehand();
      map.off("pm:create", handleCreate);
      map.off("pm:remove", handlePmRemove);
      map.off("click", handleMapClick);
      mapContainer.removeEventListener("mousedown", handleFreehandMouseDown, true);
      window.removeEventListener("mousemove", handleFreehandMouseMove);
      window.removeEventListener("mouseup", handleFreehandMouseUp);
      control.remove();
      drawnLayers.current.clear();
    };
  }, [map, publishBoundary]);

  return null;
}

export default function FarmMap({ onBoundaryChange, searchRequest, analysisOverlay }) {
  return (
    <div className="farm-map">
      <MapContainer
        center={[12.6819, 78.62]}
        zoom={13}
        style={{ height: "450px", width: "100%" }}
      >
        <TileLayer
          attribution="Tiles &copy; Esri"
          url="https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"
        />
        <TileLayer
          attribution="Labels &copy; Esri"
          url="https://services.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}"
        />
        <MapSearchController searchRequest={searchRequest} />
        <DrawingTools onBoundaryChange={onBoundaryChange} />
        <AnalysisOverlay data={analysisOverlay} />
      </MapContainer>
    </div>
  );
}

function MapSearchController({ searchRequest }) {
  const map = useMap();

  useEffect(() => {
    if (!searchRequest) return;
    map.setView([searchRequest.lat, searchRequest.lon], 15);
  }, [map, searchRequest]);

  return null;
}


function AnalysisOverlay({ data }) {
  const map = useMap();

  useEffect(() => {
    if (!data || data.type !== "FeatureCollection" || !Array.isArray(data.features) || data.features.length === 0) {
      return undefined;
    }

    const layer = L.geoJSON(data, {
      style: {
        color: "#b91c1c",
        weight: 1,
        fillColor: "#ef4444",
        fillOpacity: 0.55,
      },
      interactive: false,
    }).addTo(map);

    return () => {
      map.removeLayer(layer);
    };
  }, [map, data]);

  return null;
}
