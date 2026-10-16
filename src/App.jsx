import { useMemo, useState } from "react";
import area from "@turf/area";
import "./App.css";
import FarmMap from "./FarmMap";

const API_BASE = "http://127.0.0.1:8000";

function App() {
  const [location, setLocation] = useState("");
  const [searchRequest, setSearchRequest] = useState(null);
  const [boundary, setBoundary] = useState({
    type: "FeatureCollection",
    features: [],
  });
  const [searching, setSearching] = useState(false);

  const [beforeStart, setBeforeStart] = useState("2025-01-01");
  const [beforeEnd, setBeforeEnd] = useState("2025-03-31");
  const [afterStart, setAfterStart] = useState("2025-04-01");
  const [afterEnd, setAfterEnd] = useState("2025-06-30");

  const [loadingImages, setLoadingImages] = useState(false);
  const [loadingAnalysis, setLoadingAnalysis] = useState(false);
  const [satelliteError, setSatelliteError] = useState("");
  const [analysisError, setAnalysisError] = useState("");
  const [beforeImages, setBeforeImages] = useState([]);
  const [afterImages, setAfterImages] = useState([]);
  const [selectedImage, setSelectedImage] = useState(null);
  const [analysis, setAnalysis] = useState(null);
  const [analysisMessage, setAnalysisMessage] = useState("");

  const features = boundary.features || [];
  const farmBoundary = useMemo(
    () => features.find((feature) => feature.properties?.role === "farm") || null,
    [features]
  );

  // Calculate farm area from the farm boundary only. Damaged and non-damaged
  // areas remain complementary, matching the existing app behavior.
  const areaForRole = (role) =>
    features
      .filter((feature) => feature.properties?.role === role)
      .reduce((sum, feature) => sum + area(feature), 0);

  const farmAreaM2 = areaForRole("farm");
  const drawnDamagedAreaM2 = areaForRole("damaged");
  const drawnNonDamagedAreaM2 = areaForRole("nonDamaged");
  const hasDamagedRegions = features.some(
    (feature) => feature.properties?.role === "damaged"
  );
  const hasNonDamagedRegions = features.some(
    (feature) => feature.properties?.role === "nonDamaged"
  );

  let damagedAreaM2 = 0;
  let nonDamagedAreaM2 = 0;
  if (farmAreaM2 > 0 && hasDamagedRegions) {
    damagedAreaM2 = Math.min(farmAreaM2, drawnDamagedAreaM2);
    nonDamagedAreaM2 = farmAreaM2 - damagedAreaM2;
  } else if (farmAreaM2 > 0 && hasNonDamagedRegions) {
    nonDamagedAreaM2 = Math.min(farmAreaM2, drawnNonDamagedAreaM2);
    damagedAreaM2 = farmAreaM2 - nonDamagedAreaM2;
  }

  const toHectares = (m2) => m2 / 10000;
  const toAcres = (m2) => m2 / 4046.8564224;

  const clearAnalysis = () => {
    setAnalysis(null);
    setAnalysisMessage("");
    setAnalysisError("");
  };

  const handleSearch = async (event) => {
    event.preventDefault();
    const query = location.trim();
    if (!query) {
      alert("Please enter a location.");
      return;
    }

    setSearching(true);
    try {
      const url =
        "https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&q=" +
        encodeURIComponent(query);
      const response = await fetch(url);
      if (!response.ok) throw new Error("Location search failed");
      const results = await response.json();
      if (results.length === 0) {
        alert("Location not found. Please try another place.");
        return;
      }

      const result = results[0];
      setSearchRequest({
        lat: Number(result.lat),
        lon: Number(result.lon),
        name: result.display_name,
      });
      setBeforeImages([]);
      setAfterImages([]);
      setSelectedImage(null);
      setSatelliteError("");
      clearAnalysis();
    } catch (error) {
      console.error(error);
      alert("Unable to search. Please check your internet connection and try again.");
    } finally {
      setSearching(false);
    }
  };

  const validateDateRanges = () => {
    if (beforeStart > beforeEnd) return "The before-period start date must be on or before its end date.";
    if (afterStart > afterEnd) return "The after-period start date must be on or before its end date.";
    if (beforeEnd >= afterStart) return "The before period must end before the after period begins.";
    return "";
  };

  const handleSatelliteSearch = async () => {
    setSatelliteError("");
    setAnalysisError("");
    setBeforeImages([]);
    setAfterImages([]);
    setSelectedImage(null);
    clearAnalysis();

    if (!farmBoundary) {
      setSatelliteError("Please draw your farm boundary on the map first. The satellite search will then use that exact field area.");
      return;
    }
    const dateError = validateDateRanges();
    if (dateError) {
      setSatelliteError(dateError);
      return;
    }

    setLoadingImages(true);
    try {
      const response = await fetch(`${API_BASE}/api/before-after-search`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          farm_boundary: farmBoundary,
          before_start: beforeStart,
          before_end: beforeEnd,
          after_start: afterStart,
          after_end: afterEnd,
          max_items: 10,
        }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(data.detail || `Satellite API returned HTTP ${response.status}`);
      }
      setBeforeImages(data.before?.images || []);
      setAfterImages(data.after?.images || []);
      if (!(data.before?.images?.length) || !(data.after?.images?.length)) {
        setSatelliteError(data.message || "No suitable satellite scenes were found for one or both periods. Try wider date ranges.");
      }
    } catch (error) {
      console.error("Before/after satellite search error:", error);
      setSatelliteError(`${error.message || "Unable to load satellite images."} Make sure the Python backend is running at ${API_BASE}.`);
    } finally {
      setLoadingImages(false);
    }
  };

  const handleFloodAnalysis = async () => {
    setAnalysisError("");
    setAnalysis(null);
    setAnalysisMessage("");

    if (!farmBoundary) {
      setAnalysisError("Draw a farm boundary before starting the analysis.");
      return;
    }
    const dateError = validateDateRanges();
    if (dateError) {
      setAnalysisError(dateError);
      return;
    }

    setLoadingAnalysis(true);
    try {
      const response = await fetch(`${API_BASE}/api/flood-water-analysis`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          farm_boundary: farmBoundary,
          before_start: beforeStart,
          before_end: beforeEnd,
          after_start: afterStart,
          after_end: afterEnd,
          max_items: 10,
        }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(data.detail || `Flood analysis returned HTTP ${response.status}`);
      }
      setAnalysis(data.analysis || null);
      setAnalysisMessage(data.message || "Analysis completed.");
      if (!data.analysis) throw new Error("The backend did not return analysis results.");
    } catch (error) {
      console.error("Flood analysis error:", error);
      setAnalysisError(`${error.message || "Unable to complete flood analysis."} Check the backend terminal for details.`);
    } finally {
      setLoadingAnalysis(false);
    }
  };

  const formatDate = (value) =>
    value
      ? new Date(value).toLocaleDateString("en-IN", {
          day: "2-digit",
          month: "short",
          year: "numeric",
          timeZone: "UTC",
        })
      : "Date unavailable";

  const renderImageCards = (images, label) => (
    <div style={{ marginTop: "16px" }}>
      <h3>{label} ({images.length})</h3>
      {images.length === 0 ? (
        <p className="helper">No images loaded for this period yet.</p>
      ) : (
        <div className="satellite-grid">
          {images.map((image) => (
            <article
              className={`satellite-card ${selectedImage?.id === image.id ? "satellite-card-selected" : ""}`}
              key={image.id}
            >
              {image.preview_url ? (
                <button
                  type="button"
                  className="satellite-image-button"
                  onClick={() => setSelectedImage(image)}
                  aria-label={`View satellite image captured on ${image.date}`}
                >
                  <img
                    src={image.preview_url}
                    alt={`Sentinel-2 satellite preview captured on ${image.date}`}
                    className="satellite-preview"
                    loading="lazy"
                  />
                </button>
              ) : (
                <div className="satellite-no-preview">Preview unavailable</div>
              )}
              <div className="satellite-card-info">
                <p><strong>Capture date</strong></p>
                <p>{formatDate(image.date)}</p>
                <p>
                  <strong>Cloud cover:</strong>{" "}
                  {typeof image.cloud_cover === "number" ? `${image.cloud_cover.toFixed(2)}%` : "Unknown"}
                </p>
                <p style={{ overflowWrap: "anywhere", fontSize: "0.8rem" }}>{image.id}</p>
                <button type="button" onClick={() => setSelectedImage(image)}>View Image</button>
              </div>
            </article>
          ))}
        </div>
      )}
    </div>
  );

  return (
    <div className="app">
      <header className="header">
        <h1>AI Crop Intelligence</h1>
        <p>Satellite-Based Agricultural Monitoring and Disaster Assessment</p>
      </header>

      <main className="dashboard">
        <section className="welcome">
          <h2>Welcome, Farmer / Admin</h2>
          <p>Select your agricultural land to estimate possible disaster impact using Sentinel-2 satellite images.</p>
        </section>

        <section className="location-card">
          <h2>Step 1: Search for Your Location</h2>
          <form onSubmit={handleSearch}>
            <label htmlFor="location">Enter village, district, place name, or address</label>
            <div className="location-search-row">
              <input
                id="location"
                type="text"
                placeholder="Example: Vaniyambadi, Tamil Nadu"
                value={location}
                onChange={(event) => setLocation(event.target.value)}
              />
              <button type="submit" disabled={searching}>
                {searching ? "Searching..." : "Search Location"}
              </button>
            </div>
          </form>
          {searchRequest && <p className="search-result">Selected location: {searchRequest.name}</p>}
          <p className="helper">You can also navigate directly on the satellite map and draw your field.</p>
        </section>

        <section className="location-card">
          <h2>Step 2: Draw Your Agricultural Land</h2>
          <p className="helper">Use the map drawing tools to draw one farm boundary around your field. Search by location or move the map manually.</p>
          <FarmMap
            onBoundaryChange={setBoundary}
            searchRequest={searchRequest}
            analysisOverlay={analysis?.candidate_water_geojson || null}
          />
          <div className="area-results">
            <h3>Selected Agricultural Land</h3>
            <p>Number of shapes: <strong>{features.length}</strong></p>
            <p>Total farm area: <strong>{toHectares(farmAreaM2).toFixed(4)} hectares</strong> ({toAcres(farmAreaM2).toFixed(4)} acres)</p>
            <p>Manually marked damaged area: <strong>{toHectares(damagedAreaM2).toFixed(4)} hectares</strong> ({toAcres(damagedAreaM2).toFixed(4)} acres)</p>
            <p>Remaining / non-damaged area: <strong>{toHectares(nonDamagedAreaM2).toFixed(4)} hectares</strong> ({toAcres(nonDamagedAreaM2).toFixed(4)} acres)</p>
            {!farmBoundary && <p>Draw a farm boundary on the map to calculate its area and analyze satellite imagery.</p>}
          </div>
        </section>

        <section className="location-card satellite-section">
          <h2>Step 3: Choose Before-and-After Dates</h2>
          <p className="helper">Choose a period before the disaster and a separate period after it. The before period must end before the after period begins.</p>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: "16px", margin: "16px 0" }}>
            <label style={{ display: "grid", gap: "6px" }}>Before period starts
              <input type="date" value={beforeStart} max={beforeEnd} onChange={(event) => setBeforeStart(event.target.value)} style={{ padding: "10px", border: "1px solid #cbd5e1", borderRadius: "8px" }} />
            </label>
            <label style={{ display: "grid", gap: "6px" }}>Before period ends
              <input type="date" value={beforeEnd} min={beforeStart} max={afterStart} onChange={(event) => setBeforeEnd(event.target.value)} style={{ padding: "10px", border: "1px solid #cbd5e1", borderRadius: "8px" }} />
            </label>
            <label style={{ display: "grid", gap: "6px" }}>After period starts
              <input type="date" value={afterStart} min={beforeEnd} max={afterEnd} onChange={(event) => setAfterStart(event.target.value)} style={{ padding: "10px", border: "1px solid #cbd5e1", borderRadius: "8px" }} />
            </label>
            <label style={{ display: "grid", gap: "6px" }}>After period ends
              <input type="date" value={afterEnd} min={afterStart} onChange={(event) => setAfterEnd(event.target.value)} style={{ padding: "10px", border: "1px solid #cbd5e1", borderRadius: "8px" }} />
            </label>
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: "12px" }}>
            <button type="button" onClick={handleSatelliteSearch} disabled={loadingImages || !farmBoundary}>
              {loadingImages ? "Searching Sentinel-2..." : "Search Before-and-After Images"}
            </button>
            <button type="button" onClick={handleFloodAnalysis} disabled={loadingAnalysis || !farmBoundary}>
              {loadingAnalysis ? "Analyzing images..." : "Analyze Possible Flood Impact"}
            </button>
          </div>
          {!farmBoundary && <p className="helper">Draw the farm boundary first to enable satellite search and analysis.</p>}
          {satelliteError && <p className="satellite-error" role="alert">{satelliteError}</p>}
          {analysisError && <p className="satellite-error" role="alert">{analysisError}</p>}

          {beforeImages.length > 0 && renderImageCards(beforeImages, "Before-period Sentinel-2 images")}
          {afterImages.length > 0 && renderImageCards(afterImages, "After-period Sentinel-2 images")}

          {selectedImage && (
            <div className="selected-satellite" style={{ marginTop: "20px" }}>
              <h3>Selected Satellite Preview</h3>
              <p><strong>Capture date:</strong> {formatDate(selectedImage.date)}</p>
              <p><strong>Image ID:</strong> {selectedImage.id}</p>
              {selectedImage.preview_url && <img src={selectedImage.preview_url} alt="Selected Sentinel-2 satellite preview" className="selected-satellite-preview" />}
              <button type="button" onClick={() => setSelectedImage(null)}>Close Preview</button>
            </div>
          )}
        </section>

        {analysis && (
          <section className="location-card">
            <h2>Step 4: Flood-Water Comparison Results</h2>
            {analysisMessage && <p>{analysisMessage}</p>}
            <p className="helper">These are estimates of newly detected water, not confirmed crop damage. Review the overlay and validate the result locally.</p>
            <div className="area-results">
              <p>Farm area used by analysis: <strong>{analysis.farm_area_hectares} hectares</strong> ({analysis.farm_area_acres} acres)</p>
              <p>Newly detected water: <strong>{analysis.newly_detected_water_area_hectares} hectares</strong> ({analysis.newly_detected_water_area_acres} acres)</p>
              <p>Estimated share of farm: <strong>{analysis.newly_detected_water_percent_of_farm}%</strong></p>
              <p>Comparable valid-pixel coverage: <strong>{analysis.common_valid_coverage_percent}%</strong></p>
              <p>Before image date: <strong>{formatDate(analysis.before_date)}</strong></p>
              <p>After image date: <strong>{formatDate(analysis.after_date)}</strong></p>
              <p>New-water pixels detected: <strong>{analysis.newly_detected_water_pixels}</strong></p>
            </div>
            {analysis.warning && <p className="helper">{analysis.warning}</p>}
            <details>
              <summary>Show technical method and image IDs</summary>
              <p>{analysis.method}</p>
              <p><strong>Before scene:</strong> {analysis.before_scene_id}</p>
              <p><strong>After scene:</strong> {analysis.after_scene_id}</p>
            </details>
            <p className="helper">The detected candidate-water polygons are shown in red on the map above. If no red area appears, the analysis may not have detected qualifying water pixels.</p>
          </section>
        )}
      </main>
    </div>
  );
}

export default App;
