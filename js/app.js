(() => {
  const YEARS = Array.from({ length: 16 }, (_, i) => 2010 + i);
  const METRICS = {
    yield_t_ha: { label: "Yield", unit: "t/ha", colors: ["#e5eff8", "#c8ddf1", "#6e9fd1", "#285b94"] },
    planted_area_ha: { label: "Planted area", unit: "ha", colors: ["#f5e0e4", "#e8cbd0", "#d09ea7", "#9f6570"] }
  };
  const HAZARDS = [
    ["FD", "Inland Flood"], ["SL", "Sea Level Rise / Coastal Inundation"],
    ["HW", "Heat Wave"], ["CS", "Cold Stress"], ["DR", "Drought"],
    ["ER", "Extreme Rainfall"], ["SS", "Severe Storm"], ["WF", "WildFire"],
    ["LS", "Landslide"], ["TC", "Temperature Change"],
    ["PC", "Change in Precipitation patterns"], ["AL", "Overall multi-hazard"]
  ];
  const HAZARD_GROUPS = [
    { label: "Past", tooltip: "Historical reference value for all scenarios", columns: [{ label: "", period: "hist", scenario: "hist" }] },
    { label: "SSP1 · RCP2.6", columns: ["2030", "2040", "2050"].map(period => ({ label: period, period, scenario: "ssp1rcp26" })) },
    { label: "SSP2 · RCP4.5", columns: ["2030", "2040", "2050"].map(period => ({ label: period, period, scenario: "ssp2rcp45" })) },
    { label: "SSP5 · RCP8.5", columns: ["2030", "2040", "2050"].map(period => ({ label: period, period, scenario: "ssp5rcp85" })) }
  ];
  const HAZARD_API_KEY = "WEvWdypkC3gtLz12V1sbEy3GdiiBDXlD";
  const HAZARD_API_EMAIL = "alma@weathertrade.net";
  const DEFAULT_MAP_CENTER = [32.737, -101.957];
  const CLIMATE_PROJECTION_YEARS = [2030, 2035];
  let metric = "yield_t_ha", selectedYear = 2025, modalYear = 2025, modalMetric = "yield_t_ha", annual = {}, cityPoints = {}, cottonContext = { seasons: {}, pests: [] }, countyLayer, scaleBreaks = [0, 0, 0];
  let climateManifest = null, climateStage = "overall";
  let selectedFips = null, selectedBoundaryName = null, selectedCenter = null;
  const hazardCache = new Map(), weatherCache = new Map(), forecastCache = new Map(), seasonalCache = new Map(), climateCache = new Map(), climateProjectionCache = new Map();
  let modalWeatherLocation = null, playbackTimer = null, isPlaying = false, modalPlaybackTimer = null, modalIsPlaying = false;
  const map = L.map("map", { zoomControl: false, minZoom: 2, maxZoom: 9 }).setView(DEFAULT_MAP_CENTER, 5);
  L.control.zoom({ position: "bottomright" }).addTo(map);
    L.tileLayer(
      'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
      {
        maxZoom: 19,
        attribution:
          '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
      }
    ).addTo(map);
  map.on("click", () => document.getElementById("mapNote")?.classList.add("dismissed"));
  const fips = value => String(value).padStart(5, "0");
  const recordFor = id => annual[selectedYear]?.counties?.[fips(id)] || null;
  const valueFor = id => recordFor(id)?.[metric] ?? null;
  const format = value => value == null ? "—" : new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(value);
  const geographyLabel = record => ({ district: "District", municipality: "Municipality", province: "Province", country: "Country" }[record?.geography_type] || "County");
  const availableYears = () => Object.keys(annual).map(Number).sort((a, b) => b - a);
  const yearOptions = () => availableYears().map(year => `<option value="${year}" ${year === selectedYear ? "selected" : ""}>${year}</option>`).join("");

  async function loadInternationalRegions() {
    const base = await fetch("data/international-cotton-regions.geo.json").then(response => response.json());
    const sourceManifest = await fetch("data/missing-boundary-sources.json").then(response => response.ok ? response.json() : { sources: [] }).catch(() => ({ sources: [] }));
    const existing = new Set((base.features || []).map(feature => String(feature.id || "")));
    const additions = await Promise.all((sourceManifest.sources || []).filter(item => !existing.has(String(item.id))).map(async item => {
      try {
        const payload = await fetch(item.url).then(response => { if (!response.ok) throw new Error(`Boundary HTTP ${response.status}`); return response.json(); });
        const sourceFeature = payload?.type === "FeatureCollection" ? payload.features?.find(feature => feature?.geometry) : payload?.type === "Feature" ? payload : payload?.type && payload?.coordinates ? { geometry: payload } : null;
        if (!sourceFeature?.geometry) return null;
        return { type: "Feature", id: item.id, properties: { name: item.name, state: item.state, country: item.country, geography_type: item.geography_type, boundary_source: item.source }, geometry: sourceFeature.geometry };
      } catch (error) {
        console.warn(`Could not load boundary ${item.id}`, error);
        return null;
      }
    }));
    base.features = [...(base.features || []), ...additions.filter(Boolean)];
    return base;
  }

  renderLoadingState();
  Promise.all([
    fetch("data/us-counties.topo.json").then(response => response.json()),
    fetch("data/india-districts.geo.json").then(response => response.json()),
    loadInternationalRegions(),
    fetch("data/us-county-cities.json").then(response => response.ok ? response.json() : {}).catch(() => ({})),
    fetch("data/cotton_context.json").then(response => response.ok ? response.json() : { seasons: {}, pests: [] }).catch(() => ({ seasons: {}, pests: [] })),
    fetch("data/climate/manifest.json").then(response => response.ok ? response.json() : null).catch(() => null),
    Promise.all(YEARS.map(year => fetch(`data/cotton_${year}.json`).then(response => response.ok ? response.json() : null).catch(() => null))),
    Promise.all(YEARS.map(year => fetch(`data/cotton_india_${year}.json`).then(response => response.ok ? response.json() : null).catch(() => null))),
    Promise.all(YEARS.map(year => fetch(`data/cotton_international_${year}.json`).then(response => response.ok ? response.json() : null).catch(() => null)))
  ]).then(([topology, indiaDistricts, internationalRegions, cityData, contextData, climateData, yearData, indiaYearData, internationalYearData]) => {
    cityPoints = cityData;
    cottonContext = contextData;
    climateManifest = climateData;
    yearData.forEach((data, i) => { if (data) annual[YEARS[i]] = data; });
    indiaYearData.forEach((data, i) => {
      if (!data) return;
      annual[YEARS[i]] ||= { metadata: { year: YEARS[i] }, counties: {} };
      Object.assign(annual[YEARS[i]].counties, data.counties || {});
    });
    internationalYearData.forEach((data, i) => {
      if (!data) return;
      annual[YEARS[i]] ||= { metadata: { year: YEARS[i] }, counties: {} };
      Object.assign(annual[YEARS[i]].counties, data.counties || {});
    });
    selectedYear = Math.max(...availableYears()); refreshScale();
    const counties = topojson.feature(topology, topology.objects.counties);
    counties.features.push(...(indiaDistricts.features || []), ...(internationalRegions.features || []));
    countyLayer = L.geoJSON(counties, {
      style: featureStyle,
      onEachFeature: (feature, layer) => layer.on({
        click: () => selectCounty(feature, layer),
        mouseover: event => event.target.setStyle({ weight: 1.4, color: "#273d2e" }),
        mouseout: event => { if (fips(feature.id) !== selectedFips) countyLayer.resetStyle(event.target); }
      })
    }).addTo(map);
    selectDefaultCounty(); updateLegend(); attachMapPlayback(); startPlayback(true);
  }).catch(() => { document.getElementById("details").innerHTML = '<div class="no-data">The cotton-region map could not be loaded.</div>'; });

  function calculateThresholds() {
    const values = Object.keys(annual[selectedYear]?.counties || {}).map(valueFor).filter(value => Number.isFinite(value) && value !== 0).sort((a, b) => a - b);
    return values.length ? [.25, .5, .75].map(p => values[Math.floor((values.length - 1) * p)]) : [0, 0, 0];
  }
  function refreshScale() { scaleBreaks = calculateThresholds(); }
  function fillColor(value) {
    if (!Number.isFinite(value) || value === 0) return "#f7f9ff";
    const [a, b, c] = scaleBreaks, colors = METRICS[metric].colors;
    return value <= a ? colors[0] : value <= b ? colors[1] : value <= c ? colors[2] : colors[3];
  }
  function featureStyle(feature) {
    const id = fips(feature.id);
    const value = valueFor(id), hasShading = Number.isFinite(value) && value !== 0;
    return { fillColor: fillColor(value), fillOpacity: hasShading ? .9 : 0, color: id === selectedFips ? "#17291e" : "#aaa69c", weight: id === selectedFips ? 2.2 : .35 };
  }
  function selectCounty(feature, layer) {
    selectedFips = fips(feature.id); selectedBoundaryName = feature.properties?.name || `County ${selectedFips}`;
    selectedCenter = layer.getBounds().getCenter();
    const latestAvailable = availableYears().find(year => annual[year]?.counties?.[selectedFips]);
    if (!annual[selectedYear]?.counties?.[selectedFips] && latestAvailable) {
      stopPlayback();
      selectedYear = latestAvailable;
      refreshScale();
      updateLegend();
      updatePlaybackUI();
    }
    countyLayer.setStyle(featureStyle); layer.bringToFront(); renderDetails();
    document.getElementById("mapNote")?.classList.add("dismissed");
  }
  function selectDefaultCounty() {
    const records = annual[selectedYear]?.counties || {};
    const winner = Object.entries(records).filter(([, record]) => (!record.country || record.country === "United States") && Number.isFinite(record.planted_area_ha)).sort((a, b) => b[1].planted_area_ha - a[1].planted_area_ha)[0];
    if (!winner) { renderEmptyState(); return; }
    selectedFips = winner[0]; selectedBoundaryName = winner[1].county;
    let selectedLayer = null;
    countyLayer.eachLayer(layer => { if (fips(layer.feature?.id) === selectedFips) selectedLayer = layer; });
    selectedCenter = selectedLayer?.getBounds().getCenter() || null;
    countyLayer.setStyle(featureStyle); selectedLayer?.bringToFront();
    requestAnimationFrame(() => {
      map.invalidateSize();
      map.setView(DEFAULT_MAP_CENTER, 5, { animate: false });
    });
    renderDetails();
  }
  function yearControl() { return `<select id="yearSelect" class="year-select" aria-label="Data year">${yearOptions()}</select>`; }
  function applyYear(year, pausePlayback = false) {
    if (!annual[year]) return;
    if (pausePlayback) stopPlayback();
    selectedYear = year;
    refreshScale();
    if (countyLayer) countyLayer.setStyle(featureStyle);
    updateLegend();
    updatePlaybackUI();
    selectedFips ? renderDetails() : renderEmptyState();
  }
  function attachYearControl() {
    document.getElementById("yearSelect")?.addEventListener("change", event => {
      applyYear(Number(event.target.value), true);
    });
  }
  function updatePlaybackUI() {
    const display = document.getElementById("mapYearDisplay"), slider = document.getElementById("mapYearSlider");
    const icon = document.getElementById("mapPlayIcon"), label = document.getElementById("mapPlayLabel"), toggle = document.getElementById("mapPlayToggle");
    if (display) {
      display.textContent = selectedYear;
      display.className = `map-year-display year-tone-${selectedYear % 4}`;
      display.classList.remove("year-changing");
      void display.offsetWidth;
      display.classList.add("year-changing");
    }
    if (slider) slider.value = selectedYear;
    if (icon) icon.textContent = isPlaying ? "❚❚" : "▶";
    if (label) label.textContent = isPlaying ? "Pause" : "Play";
    if (toggle) toggle.setAttribute("aria-label", isPlaying ? "Pause year animation" : "Play year animation");
  }
  function stopPlayback() {
    isPlaying = false;
    if (playbackTimer) clearInterval(playbackTimer);
    playbackTimer = null;
    updatePlaybackUI();
  }
  function startPlayback(restart = false) {
    if (playbackTimer) clearInterval(playbackTimer);
    const years = availableYears().sort((a, b) => a - b);
    if (!years.length) return;
    isPlaying = true;
    if (restart) applyYear(years[0]);
    updatePlaybackUI();
    playbackTimer = setInterval(() => {
      const index = years.indexOf(selectedYear);
      applyYear(years[(index + 1) % years.length]);
    }, 3000);
  }
  function attachMapPlayback() {
    document.getElementById("mapPlayToggle")?.addEventListener("click", () => isPlaying ? stopPlayback() : startPlayback());
    document.getElementById("mapYearSlider")?.addEventListener("input", event => applyYear(Number(event.target.value), true));
    map.getContainer().addEventListener("pointerdown", () => document.getElementById("mapNote")?.classList.add("dismissed"), { once: true });
    updatePlaybackUI();
  }
  function renderEmptyState() {
    document.getElementById("details").innerHTML = `<div class="county-toolbar"><p class="county-kicker">Data year</p>${yearControl()}</div><div class="empty-state"><span class="cotton-mark">●</span><h2>Select a county</h2><p>County values and the available annual series will appear here.</p></div>`;
    attachYearControl();
  }
  function renderLoadingState() {
    document.getElementById("details").innerHTML = '<div class="empty-state"><span class="cotton-mark">●</span><h2>Loading cotton data</h2></div>';
  }
  function metricCards(record, extraClass = "") {
    const reference = countyAverages(selectedFips);
    const period = observationPeriod(selectedFips);
    return `<div class="metrics ${extraClass}">${Object.entries(METRICS).map(([key, item]) => `<div class="metric"><div class="metric-label">${item.label}</div><div class="metric-value">${format(record[key])}<span class="metric-unit">${item.unit}</span></div><div class="metric-reference"><span>${period} average: ${format(reference[key])} ${item.unit}</span><span>Difference from average:</span>${anomalyMarkup(record[key], reference[key])}</div></div>`).join("")}</div>`;
  }
  function observationPeriod(id) {
    const years = YEARS.filter(year => Object.values(METRICS).some((_, index) => Number.isFinite(annual[year]?.counties?.[id]?.[Object.keys(METRICS)[index]])));
    return years.length ? `${Math.min(...years)}–${Math.max(...years)}` : "Available-period";
  }
  function countyAverages(id) {
    return Object.fromEntries(Object.keys(METRICS).map(key => {
      const values = YEARS.map(year => annual[year]?.counties?.[id]?.[key]).filter(Number.isFinite);
      return [key, values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null];
    }));
  }
  function changeText(current, previous) {
    if (!Number.isFinite(current) || !Number.isFinite(previous)) return "No comparable value";
    const difference = current - previous;
    const percent = previous !== 0 ? difference / Math.abs(previous) * 100 : null;
    const sign = difference > 0 ? "+" : "";
    return `${sign}${format(difference)}${percent == null ? "" : ` (${percent > 0 ? "+" : ""}${percent.toFixed(1)}%)`}`;
  }
  function anomalyMarkup(current, reference) {
    if (!Number.isFinite(current) || !Number.isFinite(reference)) return '<span class="anomaly neutral">No comparable value</span>';
    const className = current > reference ? "positive" : current < reference ? "negative" : "neutral";
    return `<span class="anomaly ${className}">${changeText(current, reference)}</span>`;
  }
  function modalValuesMarkup(year) {
    const record = annual[year]?.counties?.[selectedFips] || null;
    const reference = countyAverages(selectedFips);
    const period = observationPeriod(selectedFips);
    const season = record?.state ? cottonContext?.seasons?.[record.state] : null;
    const seasonMarkup = season ? `<div class="modal-season-dates"><span class="modal-value-label">Growing season</span><strong>${seasonDateLabel(season.start)}–${seasonDateLabel(season.end)}</strong></div>` : "";
    return `<div class="modal-values">${Object.entries(METRICS).map(([key, item]) => `<div class="modal-value"><span class="modal-value-label">${item.label}</span><strong>${record ? format(record[key]) : "—"}<small>${item.unit}</small></strong><span class="modal-comparison">${period} average: ${format(reference[key])} ${item.unit}<br>Difference from average: ${anomalyMarkup(record?.[key], reference[key])}</span></div>`).join("")}${seasonMarkup}</div>`;
  }
  function renderDetails() {
    const record = recordFor(selectedFips), county = record?.county || selectedBoundaryName, state = record?.state || selectedFips;
    const geography = geographyLabel(record);
    const place = record?.country ? `${state} · ${record.country}` : state;
    document.getElementById("details").innerHTML = `<div class="county-toolbar"><p class="county-kicker">${geography} profile</p><button class="county-expand" id="expandCounty" aria-label="Open ${county} ${geography.toLowerCase()} profile" title="Open area profile"><span class="expand-icon" aria-hidden="true"></span></button></div><h2 class="county-title">${county}</h2><p class="state-name">${place}</p><div class="metric-year-row"><span>Data year</span>${yearControl()}</div>${record ? metricCards(record) : `<div class="no-data">No cotton value is reported for this area in ${selectedYear}.</div>`}`;
    attachYearControl();
    document.getElementById("expandCounty").addEventListener("click", openCountyModal);
  }
  function openCountyModal() {
    stopPlayback();
    const record = recordFor(selectedFips), county = record?.county || selectedBoundaryName, state = record?.state || selectedFips;
    const geography = geographyLabel(record);
    const place = record?.country ? `${state} · ${record.country}` : state;
    const modal = document.getElementById("countyModal"), card = document.getElementById("countyModalCard");
    modalYear = selectedYear; modalMetric = metric;
    card.innerHTML = `<div class="modal-topbar"><div class="modal-place"><p class="county-kicker">${geography} profile</p><h2 id="modalCountyTitle">${county}</h2><p class="state-name">${place}</p></div><button class="modal-close" id="modalClose" aria-label="Close area profile">×</button></div><section class="modal-data-grid"><div class="modal-series"><div class="modal-section-head"><div><p class="county-kicker">Annual time series</p><div class="modal-chart-controls"><select id="modalYearSelect" class="year-select" aria-label="Area profile data year">${availableYears().map(item => `<option value="${item}" ${item === modalYear ? "selected" : ""}>${item}</option>`).join("")}</select><select id="modalMetricSelect" class="chart-select modal-metric-select" aria-label="Time-series parameter">${Object.entries(METRICS).map(([key, item]) => `<option value="${key}" ${key === modalMetric ? "selected" : ""}>${item.label}</option>`).join("")}</select></div></div><button id="modalPlayToggle" class="modal-play-toggle" type="button" aria-label="Pause profile year animation"><span aria-hidden="true">❚❚</span><span>Pause</span></button></div><div id="modalChart"></div><aside class="modal-values-panel chart-side-stats" id="modalValuesPanel">${modalValuesMarkup(modalYear)}</aside></div><section class="climate-anomaly-section" aria-label="Cotton climate indicators"><div class="climate-anomaly-head"><p class="county-kicker">Cotton climate indicators</p><select id="climateStageSelect" class="chart-select" aria-label="Cotton growth period"></select></div><div id="climateAnomalyContent" class="climate-anomaly-status">Loading local climate indicators…</div><aside class="weather-context-panel" id="weatherContextPanel"><p class="county-kicker">Exceptional weather factors · ${modalYear}</p><div class="weather-context-status">Checking low-yield weather anomalies…</div></aside></section></section><section class="forecast-section"><div class="forecast-tabs" role="tablist" aria-label="Area forecast and climate information"><button class="forecast-tab" type="button" role="tab" aria-selected="false" data-forecast-tab="weather">Weather forecast</button><button class="forecast-tab" type="button" role="tab" aria-selected="false" data-forecast-tab="seasonal">Seasonal forecast</button><button class="forecast-tab active" type="button" role="tab" aria-selected="true" data-forecast-tab="climate">Climate risks</button></div><div class="forecast-panel" data-forecast-panel="weather" hidden><div class="forecast-status">Select this tab to check the next seven days for cotton-relevant extremes.</div></div><div class="forecast-panel" data-forecast-panel="seasonal" hidden><div class="forecast-status">Select this tab to load the seasonal anomaly outlook.</div></div><div class="forecast-panel active" data-forecast-panel="climate"><div class="risk-heading"><h3>Physical climate risk assessment</h3></div><div class="risk-analysis-layout"><div class="risk-visual-column">${riskLegendMarkup()}<div id="riskContent" class="risk-status">Loading hazard scores…</div></div><aside id="riskInsights" class="risk-insights"><p>Historical risk analysis is loading…</p></aside></div></div></section><footer class="everloop-footer modal-profile-footer" aria-label="Everloop"><span class="footer-part">Developed by <a href="https://www.everloop.agency/" target="_blank" rel="noopener noreferrer">EVERLOOP</a></span><span class="footer-part">Schedule a demo <a href="mailto:hello@everloop.agency">hello@everloop.agency</a></span><span class="footer-part">Data &amp; Methodology: see <a href="methodology.html">FAQ</a></span></footer>`;
    modal.classList.add("open"); modal.setAttribute("aria-hidden", "false"); document.body.style.overflow = "hidden";
    document.getElementById("modalClose").addEventListener("click", closeCountyModal);
    attachModalControls();
    drawModalChart(selectedFips, modalMetric, modalYear);
    modalWeatherLocation = nearestMunicipalCenter(record, selectedCenter);
    loadClimateAnomalies(modalWeatherLocation, record);
    attachForecastTabs();
    loadHazards(selectedFips, modalWeatherLocation);
    loadWeatherContext(selectedFips, modalWeatherLocation);
    startModalPlayback();
  }
  function attachModalControls() {
    attachModalYearControl();
    document.getElementById("modalMetricSelect")?.addEventListener("change", event => {
      stopModalPlayback();
      modalMetric = event.target.value;
      drawModalChart(selectedFips, modalMetric, modalYear);
    });
    document.getElementById("modalPlayToggle")?.addEventListener("click", () => modalIsPlaying ? stopModalPlayback() : startModalPlayback());
  }
  function updateModalPlaybackUI() {
    const button = document.getElementById("modalPlayToggle");
    if (!button) return;
    button.innerHTML = modalIsPlaying ? '<span aria-hidden="true">❚❚</span><span>Pause</span>' : '<span aria-hidden="true">▶</span><span>Play</span>';
    button.setAttribute("aria-label", modalIsPlaying ? "Pause profile year animation" : "Play profile year animation");
  }
  function startModalPlayback() {
    clearInterval(modalPlaybackTimer); modalIsPlaying = true; updateModalPlaybackUI();
    modalPlaybackTimer = setInterval(() => {
      const years = availableYears().slice().sort((a, b) => a - b), index = years.indexOf(modalYear);
      updateModalYear(years[(index + 1) % years.length], false);
    }, 3000);
  }
  function stopModalPlayback() { clearInterval(modalPlaybackTimer); modalPlaybackTimer = null; modalIsPlaying = false; updateModalPlaybackUI(); }
  function attachForecastTabs() {
    document.querySelectorAll(".forecast-tab").forEach(tab => tab.addEventListener("click", () => {
      const selected = tab.dataset.forecastTab;
      document.querySelectorAll(".forecast-tab").forEach(item => { const active = item === tab; item.classList.toggle("active", active); item.setAttribute("aria-selected", String(active)); });
      document.querySelectorAll(".forecast-panel").forEach(panel => { const active = panel.dataset.forecastPanel === selected; panel.classList.toggle("active", active); panel.hidden = !active; });
      if (selected === "weather") loadWeatherForecast(selectedFips, modalWeatherLocation);
      if (selected === "seasonal") loadSeasonalForecast(selectedFips, modalWeatherLocation);
    }));
  }

  async function loadWeatherForecast(id, location) {
    const target = document.querySelector('[data-forecast-panel="weather"]');
    if (!target || !location) return;
    target.innerHTML = '<div class="forecast-status">Loading the latest forecast…</div>';
    try {
      if (!forecastCache.has(id)) {
        const url = `https://api.open-meteo.com/v1/forecast?latitude=${location.lat}&longitude=${location.lng}&daily=temperature_2m_max,temperature_2m_min,temperature_2m_mean,precipitation_sum,wind_speed_10m_max,relative_humidity_2m_mean,shortwave_radiation_sum&temperature_unit=celsius&wind_speed_unit=mph&timezone=auto&forecast_days=7`;
        const response = await fetch(url);
        if (!response.ok) throw new Error(`Forecast API returned ${response.status}`);
        forecastCache.set(id, await response.json());
      }
      if (!weatherCache.has(id)) await ensureWeatherContext(id, location);
      const daily = forecastCache.get(id)?.daily || {}, baseline = weatherCache.get(id)?.dailyBaseline || {}, dates = daily.time || [];
      const indicators = [
        { label: "Minimum temperature", key: "temperature_2m_min", baseline: "tmin", unit: "°C", definition: "Frost below 0°C; hot night above 25°C." },
        { label: "Maximum temperature", key: "temperature_2m_max", baseline: "tmax", unit: "°C", definition: "Extreme heat above 40°C." },
        { label: "Mean temperature", key: "temperature_2m_mean", baseline: "tmean", unit: "°C", definition: "Insufficient heat below 15.6°C." },
        { label: "Precipitation", key: "precipitation_sum", baseline: "precipitation", unit: "mm", definition: "Dry day below 1 mm; rainy day at or above 1 mm; heavy rain at or above 10 mm." },
        { label: "Maximum wind", key: "wind_speed_10m_max", baseline: "wind", unit: "mph", definition: "Wind stress at or above 20 mph; damaging wind at or above 30 mph." },
        { label: "Mean relative humidity", key: "relative_humidity_2m_mean", baseline: "humidity", unit: "%", definition: "High-moisture day at or above 80%." },
        { label: "Solar radiation", key: "shortwave_radiation_sum", baseline: "radiation", unit: "MJ/m²", definition: "Incoming shortwave radiation; unusually low values indicate insufficient sunlight." }
      ];
      const dateHeads = dates.map(date => `<th>${new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" }).format(new Date(`${date}T12:00:00Z`))}</th>`).join("");
      const cell = (indicator, date, index) => {
        const value = daily[indicator.key]?.[index], reference = baseline[date.slice(5)]?.[indicator.baseline], mean = reference?.mean, sd = reference?.sd;
        const state = !Number.isFinite(value) || !Number.isFinite(mean) ? "missing" : value > mean + (sd || 0) ? "above" : value < mean - (sd || 0) ? "below" : "normal";
        const anomaly = Number.isFinite(value) && Number.isFinite(mean) ? value - mean : null, copy = state === "normal" ? "" : state === "missing" ? "—" : `${anomaly > 0 ? "+" : ""}${anomaly.toFixed(1)}`;
        const detail = state === "missing" ? "Forecast or historical reference unavailable" : `${value.toFixed(1)} ${indicator.unit}; 2000–2025 daily average ${mean.toFixed(1)} ${indicator.unit}${Number.isFinite(sd) ? `; 1σ ${sd.toFixed(1)} ${indicator.unit}` : ""}`;
        return `<td class="season-anomaly season-${state}" title="${detail}" aria-label="${indicator.label}, ${date}: ${state === "missing" ? "unavailable" : `${state} normal; ${detail}`}">${copy}</td>`;
      };
      const rows = indicators.map(indicator => `<tr><th scope="row"><span>${indicator.label}</span><button class="indicator-info forecast-indicator-info" type="button" aria-label="Definition of ${indicator.label}" data-tooltip="${indicator.definition}">?</button></th>${dates.map((date, index) => cell(indicator, date, index)).join("")}</tr>`).join("");
      target.innerHTML = `<div class="forecast-panel-head"><div><p class="county-kicker">Cotton-weather anomalies · next 7 days</p></div>${anomalyLegendMarkup()}</div><div class="seasonal-heatmap-wrap"><table class="seasonal-heatmap weather-forecast-heatmap"><thead><tr><th>Indicator</th>${dateHeads}</tr></thead><tbody>${rows}</tbody></table></div><p class="forecast-source">Forecast by <a href="https://open-meteo.com/en/docs" target="_blank" rel="noopener noreferrer">Open-Meteo</a>, compared with the local 2000–2025 daily reference. Cells within ±1 standard deviation are left blank.</p>`;
      target.querySelectorAll(".forecast-indicator-info").forEach(button => button.addEventListener("click", event => { event.stopPropagation(); const open = button.classList.toggle("open"); target.querySelectorAll(".forecast-indicator-info.open").forEach(other => { if (other !== button || !open) other.classList.remove("open"); }); }));
    } catch (error) { target.innerHTML = '<div class="forecast-status">The weather forecast is temporarily unavailable.</div>'; }
  }
  function ensembleMean(series, index) {
    const values = Object.entries(series).filter(([key, value]) => key.startsWith("temperature_2m_mean") && Array.isArray(value)).map(([, value]) => value[index]).filter(Number.isFinite);
    return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
  }
  async function loadSeasonalForecast(id, location) {
    const target = document.querySelector('[data-forecast-panel="seasonal"]');
    if (!target || !location) return;
    target.innerHTML = '<div class="forecast-status">Loading the seasonal outlook…</div>';
    try {
      if (!seasonalCache.has(id)) {
        const url = `https://seasonal-api.open-meteo.com/v1/seasonal?latitude=${location.lat}&longitude=${location.lng}&daily=temperature_2m_mean,precipitation_sum&forecast_days=180&timezone=auto`;
        const response = await fetch(url);
        if (!response.ok) throw new Error(`Seasonal API returned ${response.status}`);
        seasonalCache.set(id, await response.json());
      }
      if (!weatherCache.has(id)) await ensureWeatherContext(id, location);
      const daily = seasonalCache.get(id)?.daily || {}, months = {};
      (daily.time || []).forEach((date, i) => {
        const month = date.slice(0, 7), item = months[month] ||= { temperatures: [], rain: 0, days: 0 };
        const temp = Number.isFinite(daily.temperature_2m_mean?.[i]) ? daily.temperature_2m_mean[i] : ensembleMean(daily, i);
        if (Number.isFinite(temp)) item.temperatures.push(temp);
        const rainSeries = Object.entries(daily).find(([key, value]) => key.startsWith("precipitation_sum") && Array.isArray(value))?.[1];
        if (Number.isFinite(rainSeries?.[i])) item.rain += rainSeries[i];
        item.days += 1;
      });
      const baseline = weatherCache.get(id)?.monthlyBaseline || {};
      const rating = (value, normal, sd) => !Number.isFinite(value) || !Number.isFinite(normal) ? "missing" : value > normal + (sd || 0) ? "above" : value < normal - (sd || 0) ? "below" : "normal";
      const monthEntries = Object.entries(months).slice(0, 6);
      const monthHeads = monthEntries.map(([month]) => `<th>${new Intl.DateTimeFormat("en-US", { month: "short", year: "numeric", timeZone: "UTC" }).format(new Date(`${month}-15T12:00:00Z`))}</th>`).join("");
      const row = (label, accessor, baselineKey, sdKey) => `<tr><th scope="row">${label}</th>${monthEntries.map(([month, item]) => { const normal = baseline[Number(month.slice(5))] || {}, value = accessor(item), state = rating(value, normal[baselineKey], normal[sdKey]); return `<td class="season-anomaly season-${state}" aria-label="${label}, ${month}: ${state === "missing" ? "unavailable" : `${state} normal`}">${state === "normal" ? "" : state === "missing" ? "—" : state === "above" ? "Above" : "Below"}</td>`; }).join("")}</tr>`;
      const temperature = item => item.temperatures.length ? item.temperatures.reduce((a, b) => a + b, 0) / item.temperatures.length : null;
      target.innerHTML = `<div class="forecast-panel-head"><div><p class="county-kicker">Cotton-relevant seasonal outlook</p></div>${anomalyLegendMarkup()}</div><div class="seasonal-heatmap-wrap"><table class="seasonal-heatmap seasonal-outlook-heatmap"><thead><tr><th>Indicator</th>${monthHeads}</tr></thead><tbody>${row("Temperature", temperature, "temperature", "temperatureSd")}${row("Precipitation", item => item.rain, "precipitation", "precipitationSd")}</tbody></table></div><p class="forecast-source">Seasonal guidance from <a href="https://open-meteo.com/en/docs/seasonal-forecast-api" target="_blank" rel="noopener noreferrer">Open-Meteo</a>, compared with the local 2000–2025 monthly reference. Cells within ±1 standard deviation are left blank.</p>`;
    } catch (error) { target.innerHTML = '<div class="forecast-status">The seasonal forecast is temporarily unavailable.</div>'; }
  }
  function attachModalYearControl() {
    document.getElementById("modalYearSelect")?.addEventListener("change", event => { stopModalPlayback(); updateModalYear(Number(event.target.value), false); });
  }
  function updateModalYear(year, pause = true) {
    if (pause) stopModalPlayback();
    modalYear = year;
    document.getElementById("modalValuesPanel").innerHTML = modalValuesMarkup(modalYear);
    if (document.getElementById("modalYearSelect")) document.getElementById("modalYearSelect").value = String(modalYear);
    attachModalYearControl();
    drawModalChart(selectedFips, modalMetric, modalYear);
    const grid = climateCache.get(climateGridId(modalWeatherLocation));
    if (grid) { renderClimateAnomalyHeatmap(grid, modalWeatherLocation); renderClimateExplanation(grid); }
  }
  function closeCountyModal() {
    stopModalPlayback();
    const modal = document.getElementById("countyModal");
    modal.classList.remove("open"); modal.setAttribute("aria-hidden", "true"); document.body.style.overflow = "";
  }
  function hazardValues(payload, period, scenario) {
    const list = payload?.hazards?.[period]?.[scenario]?.hazard || [];
    return Object.assign({}, ...list);
  }
  function riskRating(value) {
    return Number.isFinite(value) ? Math.max(1, Math.min(5, Math.ceil(value * 5))) : null;
  }
  function riskColor(rating) {
    const alpha = rating == null ? 0 : .12 + rating * .17;
    return `rgba(159,116,151,${alpha})`;
  }
  function riskLegendMarkup() {
    return `<div class="risk-legend" aria-label="Risk rating color scale"><span>Risk rating</span>${[1, 2, 3, 4, 5].map(rating => `<span class="risk-legend-step"><span class="risk-swatch" style="background:${riskColor(rating)}"></span><b>${rating}</b></span>`).join("")}</div>`;
  }
  function anomalyLegendMarkup() {
    return `<div class="climate-legend anomaly-legend" aria-label="Anomaly color legend"><span><i class="climate-legend-above"></i>Above normal</span><span><i class="climate-legend-below"></i>Below normal</span></div>`;
  }
  function nearestMunicipalCenter(record, center) {
    if (!record || !center) return center ? { name: "County reference point", lat: center.lat, lng: center.lng } : null;
    const key = `${record.state.toLowerCase()}|${record.county.toLowerCase().replace(/ county$| parish$| borough$/i, "")}`;
    const candidates = cityPoints[key] || [];
    if (!candidates.length) return { name: "County reference point", lat: center.lat, lng: center.lng };
    const winner = candidates.reduce((best, item) => {
      const distance = (item[1] - center.lat) ** 2 + (item[2] - center.lng) ** 2;
      return !best || distance < best.distance ? { name: item[0], lat: item[1], lng: item[2], distance } : best;
    }, null);
    return winner;
  }
  function climateGridToken(value) {
    const rounded = Math.round(Number(value) * 2) / 2;
    return `${rounded < 0 ? "m" : ""}${Math.abs(rounded).toFixed(1).replace(".", "p")}`;
  }
  function climateGridId(location) {
    if (!location) return null;
    const legacyKey = `g_${climateGridToken(location.lat)}_${climateGridToken(location.lng)}`;
    return climateManifest?.grid_lookup?.[legacyKey] || legacyKey;
  }
  function signedClimateValue(value, unit) {
    if (!Number.isFinite(value)) return "";
    const digits = unit === "°C-days" ? 1 : Math.abs(value) < 10 ? 1 : 0;
    return `${value > 0 ? "+" : ""}${value.toFixed(digits)}`;
  }
  function climateCell(anomaly, relative, standardDeviation, unit, isProjection, year = null) {
    if (!Number.isFinite(anomaly)) return `<td class="climate-cell climate-missing" aria-label="Missing value"></td>`;
    const beyond = Number.isFinite(standardDeviation) && standardDeviation > 0 && Math.abs(anomaly) > standardDeviation;
    const direction = beyond ? (anomaly > 0 ? "above" : "below") : "normal";
    const percent = Number.isFinite(relative) ? `${relative > 0 ? "+" : ""}${(relative * 100).toFixed(1)}%` : "relative anomaly unavailable";
    const window = isProjection ? "; five-year climate projection" : "";
    const displayed = direction === "normal" ? "" : signedClimateValue(anomaly, unit);
    return `<td class="climate-cell climate-${direction} ${isProjection ? "climate-projection" : ""} ${year === modalYear ? "climate-year-active" : ""}" ${year ? `data-year="${year}"` : ""} title="${direction === "normal" ? "Within ±1 standard deviation" : `${signedClimateValue(anomaly, unit)} ${unit}; ${percent}${window}`}">${displayed}</td>`;
  }
  function sumMetricArrays(arrays, metricCount) {
    return Array.from({ length: metricCount }, (_, metricIndex) => {
      const values = arrays.map(array => array?.[metricIndex]).filter(Number.isFinite);
      return values.length ? values.reduce((sum, value) => sum + value, 0) : null;
    });
  }
  function overallClimateStage(grid) {
    const periods = Object.values(grid.growth_periods || {}), metricIds = climateManifest.metrics.map(item => item.id);
    const sumNamed = field => Object.fromEntries(metricIds.map(id => {
      const values = periods.map(period => period?.[field]?.[id]).filter(Number.isFinite);
      return [id, values.length ? values.reduce((sum, value) => sum + value, 0) : null];
    }));
    const climatology = sumNamed("climatology");
    const standard_deviation = Object.fromEntries(metricIds.map(id => {
      const values = periods.map(period => period?.standard_deviation?.[id]).filter(Number.isFinite);
      return [id, values.length ? Math.sqrt(values.reduce((sum, value) => sum + value ** 2, 0)) : null];
    }));
    const anomaly_by_year = Object.fromEntries((grid.years || []).map(year => [String(year), Object.fromEntries(metricIds.map(id => {
      const values = periods.map(period => period?.anomaly_by_year?.[String(year)]?.[id]).filter(Number.isFinite);
      return [id, values.length ? values.reduce((sum, value) => sum + value, 0) : null];
    }))]));
    return { climatology, standard_deviation, anomaly_by_year };
  }
  function selectedClimateStage(grid) {
    if (climateStage === "overall") return { stage: overallClimateStage(grid), stageIndex: -1 };
    const stageIndex = climateManifest.stages.findIndex(stage => stage.id === climateStage);
    return { stage: grid.growth_periods?.[climateStage], stageIndex };
  }
  function projectedClimateStage(period, stageIndex) {
    if (!period) return null;
    if (stageIndex >= 0) return period.stages?.[stageIndex];
    const metricCount = climateManifest.metrics.length;
    const projected = sumMetricArrays((period.stages || []).map(stage => stage.projected), metricCount);
    const anomaly = sumMetricArrays((period.stages || []).map(stage => stage.anomaly), metricCount);
    const relative_anomaly = anomaly.map((value, index) => Number.isFinite(value) && projected[index] - value ? value / (projected[index] - value) : null);
    return { projected, anomaly, relative_anomaly };
  }
  function dailySeries(daily, name) {
    const key = Object.keys(daily || {}).find(item => item === name || item.startsWith(`${name}_`));
    return key ? daily[key] : [];
  }
  function climateMetricArray(item) {
    return [item.frost, item.dry, item.rainy, item.heavyRain, item.extremeHeat, item.hotNights, item.insufficientHeat, item.windy20, item.windy30, item.highHumidity, item.lowSun, item.gdd];
  }
  function summarizeFutureClimate(payload, grid) {
    const daily = payload?.daily || {}, times = daily.time || [];
    const tmax = dailySeries(daily, "temperature_2m_max"), tmin = dailySeries(daily, "temperature_2m_min"), tmean = dailySeries(daily, "temperature_2m_mean");
    const rain = dailySeries(daily, "precipitation_sum"), wind = dailySeries(daily, "wind_speed_10m_max"), humidity = dailySeries(daily, "relative_humidity_2m_mean"), radiation = dailySeries(daily, "shortwave_radiation_sum");
    const monthlyRadiation = {};
    times.forEach((date, index) => { const value = radiation[index]; if (Number.isFinite(value)) (monthlyRadiation[Number(date.slice(5, 7))] ||= []).push(value); });
    const clearSky = Object.fromEntries(Object.entries(monthlyRadiation).map(([month, values]) => { const sorted = values.slice().sort((a, b) => a - b); return [month, sorted[Math.floor((sorted.length - 1) * .95)]]; }));
    const byYear = {};
    times.forEach((date, index) => {
      const year = Number(date.slice(0, 4)), mmdd = date.slice(5), stageIndex = climateManifest.stages.findIndex(stage => mmdd >= stage.start && mmdd <= stage.end);
      if (stageIndex < 0) return;
      const item = (byYear[year] ||= Array.from({ length: climateManifest.stages.length }, () => ({ frost: 0, dry: 0, rainy: 0, heavyRain: 0, extremeHeat: 0, hotNights: 0, insufficientHeat: 0, windy20: 0, windy30: 0, highHumidity: 0, lowSun: 0, gdd: 0 })))[stageIndex];
      const precipitation = rain[index], maximum = tmax[index], minimum = tmin[index], mean = tmean[index], maxWind = wind[index], rh = humidity[index], solar = radiation[index], solarReference = clearSky[Number(date.slice(5, 7))];
      if (minimum < 0) item.frost += 1;
      if (Number.isFinite(precipitation)) { if (precipitation < 1) item.dry += 1; else item.rainy += 1; if (precipitation >= 10) item.heavyRain += 1; }
      if (maximum > 40) item.extremeHeat += 1;
      if (minimum > 25) item.hotNights += 1;
      if (mean < 15.6) item.insufficientHeat += 1;
      if (maxWind >= 20) item.windy20 += 1;
      if (maxWind >= 30) item.windy30 += 1;
      if (rh >= 80) item.highHumidity += 1;
      const lowSun = Number.isFinite(solar) && Number.isFinite(solarReference) && solarReference > 0 && solar / solarReference < .6;
      if (lowSun) item.lowSun += 1;
      if (Number.isFinite(mean)) item.gdd += Math.max(mean - 15.6, 0);
    });
    const periods = [{ id: "2030", years: [2028, 2029, 2030, 2031, 2032] }, { id: "2035", years: [2033, 2034, 2035, 2036, 2037] }].map(period => ({
      id: period.id,
      stages: climateManifest.stages.map((_, stageIndex) => {
        const arrays = period.years.map(year => byYear[year]?.[stageIndex]).filter(Boolean).map(climateMetricArray), count = arrays.length;
        const projected = Array.from({ length: climateManifest.metrics.length }, (_, metricIndex) => count ? arrays.reduce((sum, array) => sum + (Number(array[metricIndex]) || 0), 0) / count : null);
        const climatology = climateManifest.metrics.map(metric => grid.growth_periods?.[climateManifest.stages[stageIndex].id]?.climatology?.[metric.id]), anomaly = projected.map((value, metricIndex) => Number.isFinite(value) && Number.isFinite(climatology[metricIndex]) ? value - climatology[metricIndex] : null);
        return { projected, anomaly, relative_anomaly: anomaly.map((value, metricIndex) => Number.isFinite(value) && climatology[metricIndex] ? value / climatology[metricIndex] : null) };
      })
    }));
    return { coverage_status: "available", periods, source: "CMIP6 / Open-Meteo Climate API" };
  }
  async function loadClimateProjections(gridId, location, grid) {
    if (grid.projections?.coverage_status === "available") return;
    try {
      if (!climateProjectionCache.has(gridId)) {
        const daily = "temperature_2m_max,temperature_2m_min,temperature_2m_mean,precipitation_sum,wind_speed_10m_max,relative_humidity_2m_mean,shortwave_radiation_sum";
        const url = `https://climate-api.open-meteo.com/v1/climate?latitude=${location.lat}&longitude=${location.lng}&start_date=2028-01-01&end_date=2037-12-31&models=MRI_AGCM3_2_S&daily=${daily}&wind_speed_unit=mph`;
        climateProjectionCache.set(gridId, fetch(url).then(response => { if (!response.ok) throw new Error(`Climate API returned ${response.status}`); return response.json(); }).then(payload => summarizeFutureClimate(payload, grid)));
      }
      grid.projections = await climateProjectionCache.get(gridId);
      if (document.getElementById("countyModal").classList.contains("open") && climateGridId(modalWeatherLocation) === gridId) renderClimateAnomalyHeatmap(grid, location);
    } catch (error) { climateProjectionCache.delete(gridId); }
  }
  function renderClimateAnomalyHeatmap(grid, location) {
    const target = document.getElementById("climateAnomalyContent"), select = document.getElementById("climateStageSelect");
    if (!target || !select || !climateManifest) return;
    select.innerHTML = `<option value="overall" ${climateStage === "overall" ? "selected" : ""}>Overall growing season</option>${climateManifest.stages.map(stage => `<option value="${stage.id}" ${stage.id === climateStage ? "selected" : ""}>${stage.name} (${stage.start}–${stage.end})</option>`).join("")}`;
    select.onchange = event => { climateStage = event.target.value; renderClimateAnomalyHeatmap(grid, location); renderClimateExplanation(grid); };
    const { stageIndex, stage } = selectedClimateStage(grid);
    if (!stage) { target.textContent = "Climate indicators are unavailable for this growth period."; return; }
    const projectionPeriods = Object.fromEntries((grid.projections?.periods || []).map(period => [Number(period.id), period]));
    const headers = [...grid.years.map(year => `<th class="${year === modalYear ? "climate-year-active" : ""}" data-year="${year}">${year}</th>`), `<th class="climate-period-gap" aria-hidden="true"></th>`, ...CLIMATE_PROJECTION_YEARS.map(year => `<th class="climate-projection-head">${year}</th>`)].join("");
    const rows = climateManifest.metrics.map((item, metricIndex) => {
      const historical = grid.years.map(year => {
        const anomaly = stage.anomaly_by_year?.[String(year)]?.[item.id], climatology = stage.climatology?.[item.id];
        const relative = Number.isFinite(anomaly) && Number.isFinite(climatology) && climatology !== 0 ? anomaly / climatology : null;
        return climateCell(anomaly, relative, stage.standard_deviation?.[item.id], item.unit, false, year);
      }).join("");
      const projected = CLIMATE_PROJECTION_YEARS.map(year => { const projectedStage = projectedClimateStage(projectionPeriods[year], stageIndex); return climateCell(projectedStage?.anomaly?.[metricIndex], projectedStage?.relative_anomaly?.[metricIndex], stage.standard_deviation?.[item.id], item.unit, true); }).join("");
      const tooltip = `${item.definition} Unit: ${item.unit}.`.replaceAll('"', '&quot;');
      return `<tr><th scope="row"><span>${item.name}</span><button class="indicator-info" type="button" aria-label="Definition and unit of ${item.name}" data-tooltip="${tooltip}">?</button></th>${historical}<td class="climate-period-gap" aria-hidden="true"></td>${projected}</tr>`;
    }).join("");
    target.className = "";
    target.innerHTML = `${anomalyLegendMarkup()}<div class="climate-scroll"><table class="climate-heatmap"><colgroup><col class="climate-indicator-col">${grid.years.map(() => '<col class="climate-annual-col">').join('')}<col class="climate-gap-col"><col class="climate-future-col"><col class="climate-future-col"></colgroup><thead><tr><th>Climate indicator</th>${headers}</tr></thead><tbody>${rows}</tbody></table></div>`;
    target.querySelectorAll(".indicator-info").forEach(button => button.addEventListener("click", event => { event.stopPropagation(); const open = button.classList.toggle("open"); target.querySelectorAll(".indicator-info.open").forEach(other => { if (other !== button || !open) other.classList.remove("open"); }); }));
    renderClimateExplanation(grid);
  }
  function renderClimateExplanation(grid) {
    const target = document.getElementById("weatherContextPanel");
    if (!target || !climateManifest) return;
    const yieldValue = annual[modalYear]?.counties?.[selectedFips]?.yield_t_ha;
    const yieldAverage = countyAverages(selectedFips).yield_t_ha;
    target.innerHTML = `<p class="county-kicker">Exceptional weather factors · ${modalYear}</p>`;
    if (!Number.isFinite(yieldValue) || !Number.isFinite(yieldAverage)) { target.innerHTML += '<p class="weather-context-status">Yield and reference values are unavailable for this year.</p>'; return; }
    if (yieldValue >= yieldAverage) { target.innerHTML += '<p class="weather-context-status">No low-yield diagnosis is shown because the selected yield is not below its available-period average.</p>'; return; }
    const { stageIndex, stage } = selectedClimateStage(grid), yearIndex = grid?.years?.indexOf(modalYear);
    if (!stage || yearIndex < 0) { target.innerHTML += '<p class="weather-context-status">Climate anomalies are unavailable for the selected year and growth period.</p>'; return; }
    const adverseDirection = { rainy_days: -1, cotton_gdd_base_15_6c: -1 };
    const factors = climateManifest.metrics.map(item => {
      const anomaly = stage.anomaly_by_year?.[String(modalYear)]?.[item.id], sd = stage.standard_deviation?.[item.id];
      if (!Number.isFinite(anomaly) || !Number.isFinite(sd) || sd <= 0 || Math.abs(anomaly) <= sd) return null;
      const expected = adverseDirection[item.id] || 1;
      if (Math.sign(anomaly) !== expected) return null;
      return { item, anomaly, z: anomaly / sd };
    }).filter(Boolean).sort((a, b) => Math.abs(b.z) - Math.abs(a.z));
    const periodName = stageIndex < 0 ? "the overall growing season" : climateManifest.stages[stageIndex].name.toLowerCase();
    if (!factors.length) { target.innerHTML += `<p class="weather-context-status">Yield was below average, but no adverse weather indicator exceeded ±1 standard deviation during ${periodName}.</p>`; return; }
    target.innerHTML += `<p class="exception-intro">Yield was ${Math.abs((yieldValue - yieldAverage) / yieldAverage * 100).toFixed(1)}% below average. Only statistically exceptional, plausibly adverse factors are listed.</p><div class="exception-list">${factors.map(({ item, anomaly, z }) => `<article><strong>${item.name}</strong><span>${signedClimateValue(anomaly, item.unit)} ${item.unit} versus the 1991–2025 mean (${Math.abs(z).toFixed(1)}σ ${z > 0 ? "above" : "below"} normal). ${item.definition}.</span></article>`).join("")}</div>`;
  }
  async function loadClimateAnomalies(location, record) {
    const target = document.getElementById("climateAnomalyContent");
    const isUS = !record?.country || record.country === "United States";
    if (!target || !location || !climateManifest) { if (target) target.textContent = "Climate dataset is unavailable."; return; }
    if (!isUS) { target.textContent = "Historical and SSP5-8.5 climate-anomaly fields are not yet available for this country in the current U.S. dataset."; return; }
    const gridId = climateGridId(location);
    try {
      if (!climateCache.has(gridId)) {
        const response = await fetch(`data/climate/grids/${gridId}.json`);
        if (!response.ok) throw new Error(`Climate grid returned ${response.status}`);
        climateCache.set(gridId, await response.json());
      }
      const grid = climateCache.get(gridId);
      if (document.getElementById("countyModal").classList.contains("open")) renderClimateAnomalyHeatmap(grid, location);
      loadClimateProjections(gridId, location, grid);
    } catch (error) { target.textContent = "Climate indicators are unavailable for this reference point."; }
  }
  function renderRiskHeatmap(payload, location) {
    const groupData = HAZARD_GROUPS.map(group => ({ ...group, values: group.columns.map(column => hazardValues(payload, column.period, column.scenario)) }));
    const groupHead = groupData.map((group, index) => `${index ? '<th class="risk-gap" rowspan="2" aria-hidden="true"></th>' : ""}<th class="risk-group-title ${index === 0 ? "historical-group" : "scenario-group"}" colspan="${group.columns.length}">${index === 0 ? `<span class="past-label" title="${group.tooltip}" aria-label="Past — ${group.tooltip}">${group.label}<sup>?</sup></span>` : group.label}</th>`).join("");
    const periodHead = groupData.map((group, index) => group.columns.map(column => `<th class="${index === 0 ? "historical-period" : "scenario-period"}">${column.label}</th>`).join("")).join("");
    const rows = HAZARDS.map(([code, label]) => `<tr><th scope="row">${label}</th>${groupData.map((group, groupIndex) => group.values.map(values => { const rating = riskRating(values[code]); return `<td class="risk-cell ${groupIndex === 0 ? "historical-cell" : ""}" style="background:${riskColor(rating)};color:${rating >= 4 ? "#fff" : "#424656"}">${rating ?? "—"}</td>`; }).join("")).join('<td class="risk-gap" aria-hidden="true"></td>')}</tr>`).join("");
    document.getElementById("riskContent").className = "";
    document.getElementById("riskContent").innerHTML = `<div class="risk-scroll"><table class="risk-heatmap"><thead><tr><th rowspan="2">Hazard</th>${groupHead}</tr><tr>${periodHead}</tr></thead><tbody>${rows}</tbody></table></div>`;
    renderRiskInsights(payload);
  }
  function renderRiskInsights(payload) {
    const target = document.getElementById("riskInsights");
    if (!target) return;
    const labels = Object.fromEntries(HAZARDS);
    const historical = hazardValues(payload, "hist", "hist");
    const ranked = Object.entries(historical).filter(([code, value]) => code !== "AL" && Number.isFinite(value) && labels[code]).sort((a, b) => b[1] - a[1]);
    const describe = entries => entries.length ? entries.map(([code, value]) => `<strong>${labels[code]}</strong> (${value.toFixed(2)})`).join(" and ") : "No validated historical scores are available";
    const extreme = ranked.filter(([, value]) => value > .8);
    target.innerHTML = `<div class="risk-qa"><div class="risk-question"><h4>Two primary hidden risks for this area?</h4><p>According to historical data, the highest risk scores are ${describe(ranked.slice(0, 2))}.</p></div><div class="risk-question"><h4>Are there any other hazards (No. 3 and No. 4)?</h4><p>${ranked.length > 2 ? `The next highest historical risks are ${describe(ranked.slice(2, 4))}.` : "No additional ranked hazards are available."}</p></div><div class="risk-question"><h4>Are there any extreme risks with scores exceeding 0.8?</h4><p>${extreme.length ? `Yes. ${describe(extreme)} ${extreme.length === 1 ? "exceeds" : "exceed"} 0.8.` : "No. None of the available historical hazard scores exceeds 0.8."}</p></div></div>`;
  }
  async function loadHazards(id, location) {
    const target = document.getElementById("riskContent");
    if (!location) { target.textContent = "A municipal reference point is not available for this county."; return; }
    try {
      if (!hazardCache.has(id)) {
        const url = `https://api.weathertrade.net/api/customer/get_data/hazards?lat=${location.lat}&lon=${location.lng}&key=${encodeURIComponent(HAZARD_API_KEY)}&email=${encodeURIComponent(HAZARD_API_EMAIL)}`;
        const response = await fetch(url);
        if (!response.ok) throw new Error(`Hazard API returned ${response.status}`);
        hazardCache.set(id, await response.json());
      }
      if (document.getElementById("countyModal").classList.contains("open")) renderRiskHeatmap(hazardCache.get(id), location);
    } catch (error) {
      target.className = "risk-status";
      target.textContent = "The physical climate risk assessment is temporarily unavailable.";
    }
  }
  function cottonSeasonFor(id) {
    const record = annual[modalYear]?.counties?.[id] || YEARS.map(year => annual[year]?.counties?.[id]).find(Boolean);
    return cottonContext.seasons?.[record?.state] || { start: "04-01", end: "10-31" };
  }
  function seasonDateLabel(mmdd) {
    const [month, day] = mmdd.split("-").map(Number);
    return new Intl.DateTimeFormat("en-US", { month: "long", day: "numeric" }).format(new Date(2020, month - 1, day));
  }
  function summarizeGrowingSeason(payload, season) {
    const daily = payload?.daily || {}, summaries = {}, monthly = {}, dailyReference = {};
    (daily.time || []).forEach((date, index) => {
      const year = Number(date.slice(0, 4)), mmdd = date.slice(5), month = Number(date.slice(5, 7));
      const reference = dailyReference[mmdd] ||= { tmin: [], tmax: [], tmean: [], precipitation: [], wind: [], humidity: [], radiation: [] };
      [["tmin", daily.temperature_2m_min?.[index]], ["tmax", daily.temperature_2m_max?.[index]], ["tmean", daily.temperature_2m_mean?.[index]], ["precipitation", daily.precipitation_sum?.[index]], ["wind", daily.wind_speed_10m_max?.[index]], ["humidity", daily.relative_humidity_2m_mean?.[index]], ["radiation", daily.shortwave_radiation_sum?.[index]]].forEach(([key, value]) => { if (Number.isFinite(value)) reference[key].push(value); });
      const monthYear = monthly[month] ||= {};
      const monthItem = monthYear[year] ||= { temperatures: [], precipitation: 0 };
      if (Number.isFinite(daily.temperature_2m_mean?.[index])) monthItem.temperatures.push(daily.temperature_2m_mean[index]);
      if (Number.isFinite(daily.precipitation_sum?.[index])) monthItem.precipitation += daily.precipitation_sum[index];
      if (mmdd < season.start || mmdd > season.end) return;
      const item = summaries[year] ||= { temperatures: [], precipitation: 0, hotDays: 0, dryDays: 0, stormDays: 0, days: 0 };
      const meanTemp = daily.temperature_2m_mean?.[index], maxTemp = daily.temperature_2m_max?.[index], precipitation = daily.precipitation_sum?.[index], wind = daily.wind_speed_10m_max?.[index];
      if (Number.isFinite(meanTemp)) item.temperatures.push(meanTemp);
      if (Number.isFinite(precipitation)) item.precipitation += precipitation;
      if (Number.isFinite(maxTemp) && maxTemp >= 35) item.hotDays += 1;
      if (Number.isFinite(precipitation) && precipitation < 1) item.dryDays += 1;
      if (Number.isFinite(wind) && wind > 40) item.stormDays += 1;
      item.days += 1;
    });
    Object.values(summaries).forEach(item => { item.meanTemp = item.temperatures.length ? item.temperatures.reduce((a, b) => a + b, 0) / item.temperatures.length : null; delete item.temperatures; });
    const years = Object.keys(summaries).map(Number).filter(year => year >= 2000 && year <= 2025);
    const average = key => { const values = years.map(year => summaries[year]?.[key]).filter(Number.isFinite); return values.length ? values.reduce((a, b) => a + b, 0) / values.length : null; };
    const stats = values => { if (!values.length) return { mean: null, sd: null }; const mean = values.reduce((a, b) => a + b, 0) / values.length; return { mean, sd: Math.sqrt(values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / Math.max(1, values.length - 1)) }; };
    const dailyBaseline = Object.fromEntries(Object.entries(dailyReference).map(([date, values]) => [date, Object.fromEntries(Object.entries(values).map(([key, items]) => [key, stats(items)]))]));
    const monthlyBaseline = Object.fromEntries(Object.entries(monthly).map(([month, byYear]) => {
      const values = Object.values(byYear).map(item => ({ temperature: item.temperatures.length ? item.temperatures.reduce((a, b) => a + b, 0) / item.temperatures.length : null, precipitation: item.precipitation }));
      const temperatures = values.map(x => x.temperature).filter(Number.isFinite), precipitation = values.map(x => x.precipitation).filter(Number.isFinite), t = stats(temperatures), p = stats(precipitation);
      return [month, { temperature: t.mean, temperatureSd: t.sd, precipitation: p.mean, precipitationSd: p.sd }];
    }));
    return { season, years: summaries, monthlyBaseline, dailyBaseline, baseline: { meanTemp: average("meanTemp"), precipitation: average("precipitation"), hotDays: average("hotDays"), dryDays: average("dryDays"), stormDays: average("stormDays") } };
  }
  async function ensureWeatherContext(id, location) {
    if (weatherCache.has(id)) return weatherCache.get(id);
    const season = cottonSeasonFor(id);
    const url = `https://archive-api.open-meteo.com/v1/archive?latitude=${location.lat}&longitude=${location.lng}&start_date=2000-01-01&end_date=2025-12-31&daily=temperature_2m_min,temperature_2m_max,temperature_2m_mean,precipitation_sum,wind_speed_10m_max,relative_humidity_2m_mean,shortwave_radiation_sum&wind_speed_unit=mph&timezone=auto&models=era5_land`;
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Historical weather API returned ${response.status}`);
    const result = summarizeGrowingSeason(await response.json(), season);
    weatherCache.set(id, result);
    return result;
  }
  async function loadWeatherContext(id, location) {
    const target = document.getElementById("weatherContextPanel");
    if (!target || !location) { if (target) target.innerHTML = '<p class="county-kicker">Yield weather context</p><p>Location data is unavailable.</p>'; return; }
    try {
      await ensureWeatherContext(id, location);
      const grid = climateCache.get(climateGridId(location));
      if (grid) renderClimateExplanation(grid);
    } catch (error) {
      const grid = climateCache.get(climateGridId(location));
      if (grid) renderClimateExplanation(grid);
      else target.innerHTML = '<p class="county-kicker">Exceptional weather factors</p><p class="weather-context-status">Historical weather context is temporarily unavailable.</p>';
    }
  }
  function renderWeatherContext(id, year) {
    const target = document.getElementById("weatherContextPanel"), weather = weatherCache.get(id);
    if (!target || !weather) return;
    const selected = weather.years[year], baseline = weather.baseline;
    const record = annual[year]?.counties?.[id];
    if (!selected) { target.innerHTML = `<p class="county-kicker">Yield weather context</p><p class="weather-context-status">No growing-season weather summary is available for ${year}.</p>`; return; }
    const comparison = (value, average, digits = 0) => { const difference = value - average; return `${Math.abs(difference).toFixed(digits)} ${difference >= 0 ? "more" : "less"}`; };
    const pest = cottonContext.pests?.find(item => item.year === year && item.state === record?.state && item.county.toLowerCase() === (record?.county || "").toLowerCase());
    const fact = (title, copy) => `<div class="weather-fact"><strong>${title}</strong><span>${copy}</span></div>`;
    const pestFact = pest ? fact("Pest information", `${pest.summary} <a href="${pest.source_url}" target="_blank" rel="noopener noreferrer">${pest.source}</a>.`) : fact("Pest information", `No validated county-specific pest report is included for ${year}; this does not imply that pests were absent.`);
    target.innerHTML = `<p class="county-kicker weather-context-title">Growing-season conditions · ${year}</p><div class="weather-facts">${fact("Growing season dates for cotton in this county", `${seasonDateLabel(weather.season.start)}–${seasonDateLabel(weather.season.end)} (usual state cotton calendar applied to the county).`)}${fact("Total rainfall", `${selected.precipitation.toFixed(1)} mm — ${comparison(selected.precipitation, baseline.precipitation, 1)} relative to ${baseline.precipitation.toFixed(1)} mm (average for 2000–2025).`)}${fact("Number of days with ≥35°C", `${selected.hotDays} days — ${comparison(selected.hotDays, baseline.hotDays, 1)} relative to ${baseline.hotDays.toFixed(1)} days (average for 2000–2025).`)}${fact("Number of dry days (&lt;1 mm/day)", `${selected.dryDays} days — ${comparison(selected.dryDays, baseline.dryDays, 1)} relative to ${baseline.dryDays.toFixed(1)} days (average for 2000–2025).`)}${fact("Number of storm days (maximum wind speed &gt;40 mph)", `${selected.stormDays} days — ${comparison(selected.stormDays, baseline.stormDays, 1)} relative to ${baseline.stormDays.toFixed(1)} days (average for 2000–2025).`)}${pestFact}</div><p class="weather-disclaimer">Weather values use ERA5-Land reanalysis near ${modalWeatherLocation?.name || "the county reference point"}. <a href="https://www.weathertrade.net/blog/item/how-do-you-assess-climate-hazards-30" target="_blank" rel="noopener noreferrer">Weather methodology</a>.</p>`;
  }
  function drawChart(id, key) {
    const points = YEARS.map(year => ({ year, value: annual[year]?.counties?.[id]?.[key] })).filter(point => Number.isFinite(point.value) && point.value > 0);
    const target = document.getElementById("chart");
    if (!points.length) { target.innerHTML = '<div class="chart-message">No annual values are available yet for this county.</div>'; return; }
    const W = 310, H = 220, p = { l: 55, r: 15, t: 15, b: 48 };
    const { min, max } = chartDomain(points, key);
    const x = year => p.l + (year - 2010) / 15 * (W - p.l - p.r), y = value => p.t + (max - value) / (max - min || 1) * (H - p.t - p.b);
    const xTicks = [2010, 2014, 2018, 2022, 2025], yTicks = Array.from({ length: 5 }, (_, i) => min + (max - min) * i / 4);
    const path = points.map((d, i) => `${i ? "L" : "M"}${x(d.year)},${y(d.value)}`).join(" "), color = METRICS[key].colors[2], plotWidth = W - p.l - p.r;
    const xGrid = xTicks.map(tick => `<line class="grid-line" x1="${x(tick)}" y1="${p.t}" x2="${x(tick)}" y2="${H-p.b}" opacity=".32"/><text class="chart-label" x="${x(tick)}" y="${H-p.b+17}" text-anchor="middle">${tick}</text>`).join("");
    const yGrid = yTicks.map(tick => `<line class="grid-line" x1="${p.l}" y1="${y(tick)}" x2="${W-p.r}" y2="${y(tick)}" opacity=".32"/><text class="chart-label" x="${p.l-7}" y="${y(tick)+3}" text-anchor="end">${format(tick)}</text>`).join("");
    const zones = points.map((d, i) => { const left = i ? (x(points[i-1].year)+x(d.year))/2 : p.l, right = i < points.length-1 ? (x(d.year)+x(points[i+1].year))/2 : W-p.r; return `<rect class="hover-zone" x="${left}" y="${p.t}" width="${right-left}" height="${H-p.t-p.b}" data-year="${d.year}" data-value="${d.value}"/>`; }).join("");
    target.innerHTML = `<div class="chart-wrap"><div class="chart-tooltip" id="chartTooltip"></div><svg class="series-chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Time series for ${METRICS[key].label}">${xGrid}${yGrid}<line class="axis-line" x1="${p.l}" y1="${H-p.b}" x2="${W-p.r}" y2="${H-p.b}"/><line class="axis-line" x1="${p.l}" y1="${p.t}" x2="${p.l}" y2="${H-p.b}"/><text class="axis-title" x="${p.l+plotWidth/2}" y="${H-6}" text-anchor="middle">Year</text><text class="axis-title" transform="translate(12 ${p.t+(H-p.t-p.b)/2}) rotate(-90)" text-anchor="middle">[${METRICS[key].unit}]</text><path class="series-line" style="stroke:${color}" d="${path}"/>${points.map(d => `<circle class="series-dot" style="fill:${color}" cx="${x(d.year)}" cy="${y(d.value)}" r="4"/>`).join("")}${zones}</svg></div>`;
    const tooltip = document.getElementById("chartTooltip"), wrap = target.querySelector(".chart-wrap");
    target.querySelectorAll(".hover-zone").forEach(zone => {
      zone.addEventListener("mouseenter", () => { tooltip.innerHTML = `<b>${METRICS[key].label}</b><br>${zone.dataset.year}: ${format(Number(zone.dataset.value))} [${METRICS[key].unit}]`; tooltip.classList.add("visible"); });
      zone.addEventListener("mousemove", event => { const bounds = wrap.getBoundingClientRect(); tooltip.style.left = `${Math.min(event.clientX-bounds.left, bounds.width-150)}px`; tooltip.style.top = `${event.clientY-bounds.top}px`; });
      zone.addEventListener("mouseleave", () => tooltip.classList.remove("visible"));
    });
  }
  function chartDomain(points, key) {
    const values = points.map(point => point.value);
    const rawMin = Math.min(...values), rawMax = Math.max(...values);
    const spread = rawMax - rawMin;
    const padding = spread > 0 ? spread * .02 : Math.max(Math.abs(rawMax) * .02, 1);
    const min = Math.max(0, rawMin - padding);
    return { min, max: rawMax + padding };
  }
  function drawModalChart(id, key, activeYear) {
    const points = YEARS.map(year => ({ year, value: annual[year]?.counties?.[id]?.[key] })).filter(point => Number.isFinite(point.value) && point.value > 0);
    const target = document.getElementById("modalChart");
    if (!target || !points.length) { if (target) target.innerHTML = '<div class="chart-message">No annual values are available for this parameter.</div>'; return; }
    const W = 1200, H = 225, p = { l: 204, r: 0, t: 16, b: 39 }, climateColumnWidth = 48;
    const { min, max } = chartDomain(points, key);
    const x = year => p.l + (year - 2010 + .5) * climateColumnWidth, plotRight = p.l + 16 * climateColumnWidth, y = value => p.t + (max - value) / (max - min || 1) * (H - p.t - p.b);
    const xTicks = YEARS, yTicks = Array.from({ length: 5 }, (_, i) => min + (max - min) * i / 4);
    const path = points.map((d, i) => `${i ? "L" : "M"}${x(d.year)},${y(d.value)}`).join(" "), color = METRICS[key].colors[2];
    const xGrid = xTicks.map(tick => `<line class="grid-line" x1="${x(tick)}" y1="${p.t}" x2="${x(tick)}" y2="${H-p.b}" opacity=".2"/><text class="chart-label modal-year-label ${tick === activeYear ? "modal-year-label-active" : ""}" x="${x(tick)}" y="${H-p.b+17}" text-anchor="middle">${tick}</text>`).join("");
    const yGrid = yTicks.map(tick => `<line class="grid-line" x1="${p.l}" y1="${y(tick)}" x2="${plotRight}" y2="${y(tick)}" opacity=".28"/><text class="chart-label" x="${p.l-8}" y="${y(tick)+3}" text-anchor="end">${format(tick)}</text>`).join("");
    const zones = points.map(d => { const left = x(d.year) - climateColumnWidth / 2, right = x(d.year) + climateColumnWidth / 2; return `<rect class="hover-zone modal-year-zone" x="${left}" y="${p.t}" width="${right-left}" height="${H-p.t-p.b}" data-year="${d.year}" data-value="${d.value}" tabindex="0" role="button" aria-label="Show values for ${d.year}"/>`; }).join("");
    target.innerHTML = `<div class="chart-wrap modal-chart-wrap"><div class="chart-tooltip" id="modalChartTooltip"></div><svg class="series-chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Interactive time series for ${METRICS[key].label}">${xGrid}${yGrid}<line class="axis-line" x1="${p.l}" y1="${H-p.b}" x2="${plotRight}" y2="${H-p.b}"/><line class="axis-line" x1="${p.l}" y1="${p.t}" x2="${p.l}" y2="${H-p.b}"/><text class="axis-title" transform="translate(7 ${(p.t+H-p.b)/2}) rotate(-90)" text-anchor="middle">[${METRICS[key].unit}]</text><text class="axis-title" x="${(p.l+plotRight)/2}" y="${H-p.b+31}" text-anchor="middle">Year</text><path class="series-line" style="stroke:${color}" d="${path}"/>${points.map(d => `<circle class="series-dot ${d.year === activeYear ? "selected-year-dot" : ""}" style="fill:${color}" cx="${x(d.year)}" cy="${y(d.value)}" r="${d.year === activeYear ? 7 : 4}"/>`).join("")}${zones}</svg></div>`;
    const tooltip = document.getElementById("modalChartTooltip"), wrap = target.querySelector(".chart-wrap");
    const activate = zone => updateModalYear(Number(zone.dataset.year));
    target.querySelectorAll(".modal-year-zone").forEach(zone => {
      zone.addEventListener("click", () => activate(zone));
      zone.addEventListener("keydown", event => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); activate(zone); } });
      zone.addEventListener("mouseenter", () => { tooltip.innerHTML = `<b>${METRICS[key].label}</b><br>${zone.dataset.year}: ${format(Number(zone.dataset.value))} [${METRICS[key].unit}]`; tooltip.classList.add("visible"); });
      zone.addEventListener("mousemove", event => { const bounds = wrap.getBoundingClientRect(); tooltip.style.left = `${Math.min(event.clientX-bounds.left, bounds.width-160)}px`; tooltip.style.top = `${event.clientY-bounds.top}px`; });
      zone.addEventListener("mouseleave", () => tooltip.classList.remove("visible"));
    });
  }
  function updateLegend() {
    const t = scaleBreaks, item = METRICS[metric], gradient = `linear-gradient(90deg,${item.colors.join(",")})`;
    document.getElementById("legend").innerHTML = `<div class="legend-title">${item.label} · ${item.unit}</div><div class="legend-scale" style="background:${gradient}"></div><div class="legend-values"><span>0 / no data</span><span>${format(t[1])}+</span><span>${format(t[2])}+</span></div>`;
  }
  document.getElementById("countyModal")?.addEventListener("click", event => { if (event.target.id === "countyModal") closeCountyModal(); });
  document.addEventListener("keydown", event => { if (event.key === "Escape") closeCountyModal(); });
  document.querySelectorAll(".layer-tab[data-metric]").forEach(button => button.addEventListener("click", () => {
    metric = button.dataset.metric; refreshScale(); document.querySelectorAll(".layer-tab").forEach(item => item.classList.toggle("active", item === button));
    if (countyLayer) countyLayer.setStyle(featureStyle); updateLegend(); if (selectedFips) renderDetails();
  }));
})();
