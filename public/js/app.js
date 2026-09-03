(() => {
  const YEARS = Array.from({ length: 16 }, (_, i) => 2010 + i);
  const METRICS = {
    yield_t_ha: { label: 'Yield', unit: 't/ha', colors: ['#e5eff8','#c8ddf1','#6e9fd1','#285b94'] },
    planted_area_ha: { label: 'Planted area', unit: 'ha', colors: ['#f5e0e4','#e8cbd0','#d09ea7','#9f6570'] }
  };

  const API = '/api';
  const REQUEST_TIMEOUT_MS = 15000;
  const apiJson = async (route, timeout = REQUEST_TIMEOUT_MS) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const r = await fetch(`${API}${route}`, {
        signal: controller.signal,
        headers: { accept: 'application/json' }
      });
      if (!r.ok) throw new Error(`${route}: ${r.status}`);
      return await r.json();
    } finally {
      clearTimeout(timer);
    }
  };

  const map = L.map('map', { zoomControl: false, minZoom: 2, maxZoom: 10 }).setView([25, 10], 2);
  L.control.zoom({ position: 'bottomright' }).addTo(map);
  L.maplibreGL({ style: 'https://tiles.openfreemap.org/styles/positron' }).addTo(map);

  let selectedYear = 2025;
  let metric = 'yield_t_ha';
  let selectedId = null;
  let boundaryLayer = null;
  let currentRecords = {};
  let currentFeatures = [];
  let scaleBreaks = [0,0,0];
  let playbackTimer = null;
  let playing = false;

  const yearCache = new Map();
  const yearPromises = new Map();
  const profileCache = new Map();
  let boundariesPromise = null;
  let loadSequence = 0;


  let context = null;
  let contextPromise = null;

  const fmt = v => Number.isFinite(v)
    ? new Intl.NumberFormat('en-US',{maximumFractionDigits:2}).format(v)
    : '—';

  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({
    '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#039;'
  }[c]));

  const recordFor = id => currentRecords[String(id)] || null;
  const valueFor = id => recordFor(id)?.[metric] ?? null;

  const availableRecordValues = () =>
    Object.keys(currentRecords)
      .map(valueFor)
      .filter(v => Number.isFinite(v) && v !== 0)
      .sort((a,b)=>a-b);

  function thresholds() {
    const v = availableRecordValues();
    return v.length
      ? [.25,.5,.75].map(p => v[Math.floor((v.length-1)*p)])
      : [0,0,0];
  }

  function fillColor(v) {
    if (!Number.isFinite(v) || v === 0) return '#f7f9ff';
    const [a,b,c] = scaleBreaks;
    const cs = METRICS[metric].colors;
    return v <= a ? cs[0] : v <= b ? cs[1] : v <= c ? cs[2] : cs[3];
  }

  function style(feature) {
    const id = String(feature.id);
    const v = valueFor(id);
    const active = id === selectedId;
    return {
      fillColor: fillColor(v),
      fillOpacity: Number.isFinite(v) && v !== 0 ? .9 : 0,
      color: active ? '#17291e' : '#aaa69c',
      weight: active ? 2.2 : .4
    };
  }

  function geographyLabel(r) {
    return ({
      county:'County',
      district:'District',
      municipality:'Municipality',
      department:'Department',
      province:'Province',
      region:'Region',
      state:'State'
    }[r?.geography_type] || 'Area');
  }

  async function getContext() {
    if (context) return context;
    if (!contextPromise) {
      contextPromise = apiJson('/cotton/context')
        .then(value => {
          context = value;
          return value;
        })
        .catch(error => {
          console.warn(error);
          context = { seasons: [], issues: [] };
          return context;
        });
    }
    return contextPromise;
  }

  function showLoading() {
    document.getElementById('details').innerHTML = `
      <div class="empty-state">
        <span class="cotton-mark">●</span>
        <h2>Loading cotton data</h2>
        <p>Production records come securely from Notion.</p>
      </div>`;
  }

  function showBoundaryLoading() {
    const note = document.getElementById('mapNote');
    if (!note) return;
    note.textContent = 'Cotton data loaded. Loading administrative boundaries…';
    note.classList.remove('dismissed');
  }

  function hideBoundaryLoading() {
    const note = document.getElementById('mapNote');
    if (!note) return;
    note.textContent = 'Click a cotton-producing area to explore its profile.';
  }

  async function loadBoundariesOnce(fit = false) {
    if (boundaryLayer) return boundaryLayer;
    if (boundariesPromise) return boundariesPromise;

    showBoundaryLoading();
    boundariesPromise = apiJson('/boundaries', 25000)
      .then(payload => {
        currentFeatures = payload.boundaries?.features || [];
        boundaryLayer = L.geoJSON(
          { type:'FeatureCollection', features:currentFeatures },
          {
            style,
            onEachFeature: (f,l) => l.on({
              click: () => selectArea(f,l),
              mouseover: e => e.target.setStyle({ weight:1.4, color:'#273d2e' }),
              mouseout: e => {
                if (String(f.id) !== selectedId) boundaryLayer?.resetStyle(e.target);
              }
            })
          }
        ).addTo(map);

        if (fit && currentFeatures.length) {
          map.fitBounds(boundaryLayer.getBounds(), { padding:[20,20], maxZoom:5 });
        }
        hideBoundaryLoading();
        return boundaryLayer;
      })
      .catch(error => {
        boundariesPromise = null;
        const note = document.getElementById('mapNote');
        if (note) note.textContent = 'Cotton boundaries are temporarily unavailable.';
        throw error;
      });

    return boundariesPromise;
  }

  async function getYearPayload(year) {
    if (yearCache.has(year)) return yearCache.get(year);
    if (yearPromises.has(year)) return yearPromises.get(year);

    const promise = apiJson(`/cotton/year?year=${year}`)
      .then(payload => {
        yearCache.set(year, payload);
        return payload;
      })
      .finally(() => yearPromises.delete(year));

    yearPromises.set(year, promise);
    return promise;
  }

  function prefetchYears(year) {
    const candidates = YEARS
      .filter(y => y !== year)
      .sort((a,b) => Math.abs(a-year) - Math.abs(b-year));

    const run = () => {
      const next = candidates.find(y => !yearCache.has(y) && !yearPromises.has(y));
      if (next == null) return;
      getYearPayload(next)
        .catch(error => console.debug('Year prefetch skipped', next, error))
        .finally(() => setTimeout(run, 150));
    };

    if ('requestIdleCallback' in window) {
      window.requestIdleCallback(run, { timeout: 1200 });
    } else {
      setTimeout(run, 400);
    }
  }

  async function loadYear(year, fit = false) {
    const sequence = ++loadSequence;
    selectedYear = year;
    showLoading();
    updatePlaybackUI();

    const [payload] = await Promise.all([
      getYearPayload(year),
      loadBoundariesOnce(fit)
    ]);

    if (sequence !== loadSequence || year !== selectedYear) return;

    currentRecords = payload.records || {};
    scaleBreaks = thresholds();
    boundaryLayer?.setStyle(style);

    if (selectedId && !recordFor(selectedId)) selectedId = null;
    if (!selectedId) selectLargest();
    else renderDetails();

    renderLegend();
    prefetchYears(year);
  }

  function selectLargest() {
    const winner = Object.entries(currentRecords)
      .filter(([,r]) => Number.isFinite(r.planted_area_ha))
      .sort((a,b) => b[1].planted_area_ha - a[1].planted_area_ha)[0];

    if (!winner) return renderEmpty();

    selectedId = winner[0];
    boundaryLayer?.setStyle(style);
    renderDetails();
  }

  function selectArea(feature, layer) {
    selectedId = String(feature.id);
    boundaryLayer.setStyle(style);
    layer.bringToFront();
    renderDetails();
    document.getElementById('mapNote')?.classList.add('dismissed');
  }

  function renderEmpty() {
    document.getElementById('details').innerHTML = `
      <div class="empty-state">
        <h2>No cotton data</h2>
        <p>No production records were found for this year.</p>
      </div>`;
  }

  function metricCard(key,r) {
    const m = METRICS[key];
    return `
      <div class="metric">
        <div class="metric-label">${m.label}</div>
        <div class="metric-value">
          ${fmt(r?.[key])}<span class="metric-unit">${m.unit}</span>
        </div>
      </div>`;
  }

  function renderDetails() {
    const r = recordFor(selectedId);
    if (!r) return renderEmpty();

    const el = document.getElementById('details');
    el.innerHTML = `
      <div class="county-toolbar">
        <p class="county-kicker">${esc(geographyLabel(r))} profile</p>
        <button class="county-expand" id="expandCounty" aria-label="Open full profile">
          <span class="expand-icon"></span>
        </button>
      </div>
      <h2 class="county-title">${esc(r.county)}</h2>
      <p class="state-name">${esc([r.state,r.country].filter(Boolean).join(' · '))}</p>

      <div class="metric-year-row">
        <span>Data year</span>
        <select id="yearSelect" class="year-select">
          ${YEARS.slice().reverse().map(y =>
            `<option ${y===selectedYear?'selected':''}>${y}</option>`
          ).join('')}
        </select>
      </div>

      <div class="metrics">
        ${metricCard('yield_t_ha',r)}
        ${metricCard('planted_area_ha',r)}
      </div>

      <p class="data-origin-note">
        Cotton values are served from the private Notion database through Cloudflare.
        Public boundaries load independently and do not block the cotton data.
      </p>`;

    document.getElementById('yearSelect').onchange =
      e => loadYear(Number(e.target.value));

    document.getElementById('expandCounty').onclick =
      () => openProfile(r);
  }

  async function openProfile(r) {
    const modal = document.getElementById('countyModal');
    const card = document.getElementById('countyModalCard');

    modal.classList.add('open');
    modal.setAttribute('aria-hidden','false');
    card.innerHTML = '<div class="empty-state"><h2>Loading profile…</h2></div>';

    try {
      const [rows, ctx] = await Promise.all([
        (async () => {
          let value = profileCache.get(r.geography_id);
          if (!value) {
            value = await apiJson(`/cotton/profile?id=${encodeURIComponent(r.geography_id)}`);
            profileCache.set(r.geography_id, value);
          }
          return value;
        })(),
        getContext()
      ]);

      const season = ctx.seasons.find(x => x.geography_id === r.geography_id) ||
        ctx.seasons.find(x => x.state === r.state || x.country === r.country);

      const issue = ctx.issues.find(
        x => x.geography_id === r.geography_id && x.year === selectedYear
      ) || ctx.issues.find(
        x => x.county === r.county && x.state === r.state && x.year === selectedYear
      );

      card.innerHTML = `
        <div class="modal-topbar">
          <div class="modal-place">
            <p class="county-kicker">${esc(geographyLabel(r))} profile</p>
            <h2 id="modalCountyTitle">${esc(r.county)}</h2>
            <p class="state-name">${esc([r.state,r.country].filter(Boolean).join(' · '))}</p>
          </div>
          <button class="modal-close" id="modalClose">×</button>
        </div>

        <section class="modal-data-grid">
          <div class="modal-series">
            <p class="county-kicker">Annual cotton production series</p>
            ${seriesTable(rows)}
          </div>

          <div class="modal-stats">
            <p class="county-kicker">Cotton-specific information</p>
            <div class="weather-facts">
              ${season ? `
                <div class="weather-fact">
                  <strong>Growing season</strong>
                  <span>${esc(season.growing_season_start||'—')} – ${esc(season.growing_season_end||'—')}</span>
                </div>` : ''}

              ${issue ? `
                <div class="weather-fact">
                  <strong>Cotton issue · ${selectedYear}</strong>
                  <span>${esc(issue.cotton_issue)}${issue.source ? ` — ${esc(issue.source)}` : ''}</span>
                </div>` : ''}
            </div>
          </div>
        </section>

        <section class="modal-risk-section">
          <p class="county-kicker">Live climate services</p>
          <div id="liveClimate">
            <p>Loading current location-based climate risk…</p>
          </div>
        </section>`;

      document.getElementById('modalClose').onclick = closeModal;

      const layer = [
        ...(boundaryLayer ? Object.values(boundaryLayer._layers) : [])
      ].find(l => String(l.feature?.id) === r.geography_id);

      const center = layer?.getBounds().getCenter();
      if (center) loadHazards(center.lat,center.lng);

    } catch (e) {
      console.error(e);
      card.innerHTML = `
        <button class="modal-close" id="modalClose">×</button>
        <div class="no-data">Profile could not be loaded.</div>`;
      document.getElementById('modalClose').onclick = closeModal;
    }
  }

  function seriesTable(rows) {
    return `
      <div class="climate-scroll">
        <table class="climate-heatmap">
          <thead>
            <tr>
              <th>Year</th>
              <th>Yield (t/ha)</th>
              <th>Planted area (ha)</th>
            </tr>
          </thead>
          <tbody>
            ${rows.map(x => `
              <tr>
                <th>${x.year}</th>
                <td>${fmt(x.yield_t_ha)}</td>
                <td>${fmt(x.planted_area_ha)}</td>
              </tr>`).join('')}
          </tbody>
        </table>
      </div>`;
  }

  async function loadHazards(lat,lon) {
    const el = document.getElementById('liveClimate');
    if (!el) return;

    try {
      const p = await apiJson(`/hazards?lat=${lat}&lon=${lon}`);
      const vals = Object.entries(p || {}).slice(0,12);
      el.innerHTML = vals.length
        ? `<div class="weather-facts">${
            vals.map(([k,v]) => `
              <div class="weather-fact">
                <strong>${k}</strong>
                <span>${typeof v === 'object' ? 'Available' : String(v)}</span>
              </div>`).join('')
          }</div>`
        : '<p>Climate-risk service returned no displayable values.</p>';
    } catch (e) {
      el.innerHTML = '<p>Climate-risk service is temporarily unavailable or not configured.</p>';
    }
  }

  function closeModal() {
    const m = document.getElementById('countyModal');
    m.classList.remove('open');
    m.setAttribute('aria-hidden','true');
  }

  document.getElementById('countyModal').addEventListener('click', e => {
    if (e.target.id === 'countyModal') closeModal();
  });

  function renderLegend() {
    const m = METRICS[metric];
    const [a,b,c] = scaleBreaks;

    document.getElementById('legend').innerHTML = `
      <div class="legend-title">${m.label} · ${selectedYear}</div>
      <div class="legend-row"><i style="background:${m.colors[0]}"></i>≤ ${fmt(a)}</div>
      <div class="legend-row"><i style="background:${m.colors[1]}"></i>${fmt(a)}–${fmt(b)}</div>
      <div class="legend-row"><i style="background:${m.colors[2]}"></i>${fmt(b)}–${fmt(c)}</div>
      <div class="legend-row"><i style="background:${m.colors[3]}"></i>&gt; ${fmt(c)} ${m.unit}</div>`;
  }

  document.querySelectorAll('.layer-tab').forEach(b =>
    b.addEventListener('click', () => {
      document.querySelectorAll('.layer-tab').forEach(x => x.classList.remove('active'));
      b.classList.add('active');
      metric = b.dataset.metric;
      scaleBreaks = thresholds();
      boundaryLayer?.setStyle(style);
      renderLegend();
    })
  );

  function updatePlaybackUI() {
    const y = document.getElementById('mapYearDisplay');
    const s = document.getElementById('mapYearSlider');
    const i = document.getElementById('mapPlayIcon');
    const l = document.getElementById('mapPlayLabel');

    if (y) y.textContent = selectedYear;
    if (s) s.value = selectedYear;
    if (i) i.textContent = playing ? '❚❚' : '▶';
    if (l) l.textContent = playing ? 'Pause' : 'Play';
  }

  function stop() {
    playing = false;
    clearTimeout(playbackTimer);
    playbackTimer = null;
    updatePlaybackUI();
  }

  async function playbackStep() {
    if (!playing) return;
    const idx = YEARS.indexOf(selectedYear);
    try {
      await loadYear(YEARS[(idx+1) % YEARS.length]);
    } catch (e) {
      console.error(e);
      stop();
      return;
    }
    if (playing) playbackTimer = setTimeout(playbackStep, 3000);
  }

  function start() {
    stop();
    playing = true;
    updatePlaybackUI();
    playbackTimer = setTimeout(playbackStep, 3000);
  }

  document.getElementById('mapPlayToggle').onclick =
    () => playing ? stop() : start();

  document.getElementById('mapYearSlider').oninput =
    e => {
      stop();
      loadYear(Number(e.target.value)).catch(console.error);
    };

  Promise.all([
    getContext(),
    loadBoundariesOnce(true),
    loadYear(2025)
  ]).catch(e => {
    console.error(e);
    document.getElementById('details').innerHTML =
      '<div class="no-data">The app could not load this data. Please retry.</div>';
  });
})();
