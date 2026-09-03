const NOTION_VERSION = '2026-03-11';
const CACHE_VERSION = 'cotton-v3';
const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'vary': 'accept-encoding'
};

const COUNTRY_BOUNDARIES = {
  'United States': { iso3: 'USA', adm: 'ADM2', provider: 'census' },
  India: { iso3: 'IND', adm: 'ADM2' },
  Brazil: { iso3: 'BRA', adm: 'ADM2' },
  Mexico: { iso3: 'MEX', adm: 'ADM2' },
  Pakistan: { iso3: 'PAK', adm: 'ADM1' },
  Argentina: { iso3: 'ARG', adm: 'ADM2' },
  Uzbekistan: { iso3: 'UZB', adm: 'ADM1' },
  Spain: { iso3: 'ESP', adm: 'ADM2' },
  Turkey: { iso3: 'TUR', adm: 'ADM1' },
  China: { iso3: 'CHN', adm: 'ADM1' },
  Australia: { iso3: 'AUS', adm: 'ADM1' }
};

const json = (value, status = 200, extra = {}) => new Response(JSON.stringify(value), {
  status,
  headers: { ...JSON_HEADERS, 'cache-control': 'public, max-age=300, stale-while-revalidate=3600', ...extra }
});

async function notionFetch(env, endpoint, options = {}, retry = 0) {
  if (!env.NOTION_TOKEN || !env.NOTION_DATA_SOURCE_ID) throw new Error('Notion environment variables are missing');
  const response = await fetch(`https://api.notion.com/v1${endpoint}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${env.NOTION_TOKEN}`,
      'Notion-Version': NOTION_VERSION,
      'Content-Type': 'application/json',
      ...(options.headers || {})
    }
  });
  if (response.status === 429 && retry < 5) {
    const seconds = Number(response.headers.get('retry-after') || 1);
    await new Promise(resolve => setTimeout(resolve, seconds * 1000));
    return notionFetch(env, endpoint, options, retry + 1);
  }
  if (!response.ok) throw new Error(`Notion ${response.status}: ${await response.text()}`);
  return response.json();
}

function propText(prop) {
  if (!prop) return '';
  if (prop.type === 'title') return (prop.title || []).map(x => x.plain_text || '').join('');
  if (prop.type === 'rich_text') return (prop.rich_text || []).map(x => x.plain_text || '').join('');
  if (prop.type === 'select') return prop.select?.name || '';
  if (prop.type === 'status') return prop.status?.name || '';
  if (prop.type === 'number') return prop.number == null ? '' : String(prop.number);
  if (prop.type === 'url') return prop.url || '';
  return '';
}

function propNumber(prop) {
  if (!prop) return null;
  if (prop.type === 'number') return Number.isFinite(prop.number) ? prop.number : null;
  const n = Number(propText(prop));
  return Number.isFinite(n) ? n : null;
}

function pageRecord(page) {
  const p = page.properties || {};
  return {
    name: propText(p.Name),
    record_type: propText(p['Record Type']),
    geography_id: propText(p['Geography ID']),
    country: propText(p.Country),
    state: propText(p['State / Region']),
    county: propText(p['Local Area']),
    geography_type: propText(p['Geography Type']),
    boundary_id: propText(p['Boundary ID']),
    boundary_name: propText(p['Boundary Name']),
    year: propNumber(p.Year),
    planted_area_ha: propNumber(p['Planted Area (ha)']),
    harvested_area_ha: propNumber(p['Harvested Area (ha)']),
    yield_t_ha: propNumber(p['Yield (t/ha)']),
    production_t: propNumber(p['Production (t)']),
    growing_season_start: propText(p['Growing Season Start']),
    growing_season_end: propText(p['Growing Season End']),
    cotton_issue: propText(p['Cotton Pest / Issue']),
    source: propText(p.Source),
    source_url: propText(p['Source URL'])
  };
}

async function queryNotion(env, filter, sorts) {
  let cursor = null;
  const out = [];
  do {
    const body = {
      page_size: 100,
      ...(filter ? { filter } : {}),
      ...(sorts ? { sorts } : {}),
      ...(cursor ? { start_cursor: cursor } : {})
    };
    const data = await notionFetch(
      env,
      `/data_sources/${env.NOTION_DATA_SOURCE_ID}/query`,
      { method: 'POST', body: JSON.stringify(body) }
    );
    out.push(...data.results.map(pageRecord));
    cursor = data.has_more ? data.next_cursor : null;
  } while (cursor);
  return out;
}

const recordTypeFilter = type => ({
  property: 'Record Type',
  rich_text: { equals: type }
});

async function recordsForYear(env, year) {
  return queryNotion(env, {
    and: [
      recordTypeFilter('production'),
      { property: 'Year', number: { equals: year } }
    ]
  });
}

async function allProduction(env) {
  return queryNotion(env, recordTypeFilter('production'));
}

async function geographyRows(env) {
  // Preferred schema: one stable geography row per mapped cotton area.
  // Fallback preserves compatibility while the existing Notion table is migrated.
  const explicit = await queryNotion(env, recordTypeFilter('geography'));
  if (explicit.length) return explicit;

  const production = await allProduction(env);
  const unique = new Map();
  for (const row of production) {
    if (!row.geography_id || unique.has(row.geography_id)) continue;
    unique.set(row.geography_id, row);
  }
  return [...unique.values()];
}

function normalizeName(value) {
  return String(value || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\b(county|district|municipality|municipio|department|departamento|province|provincia|region|state)\b/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

async function fetchJson(url, ttl = 604800) {
  const response = await fetch(url, {
    headers: { accept: 'application/json', 'user-agent': 'CottonRiskManagement/4.2' },
    // Cloudflare edge-cache for large, effectively static boundary sources.
    // This avoids re-downloading the same Census/geoBoundaries files for every year.
    cf: { cacheEverything: true, cacheTtl: ttl }
  });
  if (!response.ok) throw new Error(`Boundary source ${response.status}`);
  return response.json();
}

async function openBoundaryLayer(country, records) {
  const config = COUNTRY_BOUNDARIES[country];
  if (!config || !records.length) return [];

  if (config.provider === 'census') {
    const q = new URL('https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/tigerWMS_Current/MapServer/82/query');
    const ids = records
      .map(r => String(r.boundary_id || r.geography_id || '').padStart(5, '0'))
      .filter(Boolean);
    q.searchParams.set('where', ids.length ? `GEOID IN (${ids.map(id => `'${id}'`).join(',')})` : '1=0');
    q.searchParams.set('outFields', 'GEOID,BASENAME,NAME,STATE');
    q.searchParams.set('returnGeometry', 'true');
    q.searchParams.set('outSR', '4326');
    q.searchParams.set('f', 'geojson');

    const layer = await fetchJson(q.toString());
    const byId = new Map(records.map(r => [String(r.boundary_id || r.geography_id).padStart(5, '0'), r]));

    return (layer.features || []).flatMap(feature => {
      const geoid = String(feature.properties?.GEOID || '').padStart(5, '0');
      const record = byId.get(geoid);
      if (!record) return [];
      feature.id = record.geography_id;
      feature.properties = {
        ...feature.properties,
        name: record.county,
        state: record.state,
        country,
        geography_type: record.geography_type
      };
      return [feature];
    });
  }

  const meta = await fetchJson(`https://www.geoboundaries.org/api/current/gbOpen/${config.iso3}/${config.adm}/`, 86400);
  const geometryUrl = meta.simplifiedGeometryGeoJSON || meta.gjDownloadURL;
  if (!geometryUrl) return [];
  const layer = await fetchJson(geometryUrl, 2592000);

  const byBoundaryId = new Map(
    records.filter(r => r.boundary_id).map(r => [String(r.boundary_id), r])
  );
  const index = new Map();
  for (const record of records) {
    const key = normalizeName(record.boundary_name || record.county);
    if (!key) continue;
    if (!index.has(key)) index.set(key, []);
    index.get(key).push(record);
  }

  return (layer.features || []).flatMap(feature => {
    const sourceId = String(
      feature.properties?.shapeID ||
      feature.properties?.shapeId ||
      feature.id ||
      ''
    );
    let record = byBoundaryId.get(sourceId);

    if (!record) {
      const shapeName =
        feature.properties?.shapeName ||
        feature.properties?.name ||
        feature.properties?.NAME ||
        '';
      const candidates = index.get(normalizeName(shapeName)) || [];
      if (candidates.length === 1) record = candidates[0];
    }

    if (!record) return [];
    feature.id = record.geography_id;
    feature.properties = {
      ...feature.properties,
      name: record.county,
      state: record.state,
      country,
      geography_type: record.geography_type
    };
    return [feature];
  });
}

async function cached(request, key, producer, ttl = 3600, clientTtl = 900) {
  const cache = caches.default;
  const origin = new URL(request.url).origin;
  const cacheKey = new Request(`${origin}/__cache/${CACHE_VERSION}/${encodeURIComponent(key)}`);
  const hit = await cache.match(cacheKey);

  if (hit) {
    const response = new Response(hit.body, {
      status: hit.status,
      statusText: hit.statusText,
      headers: new Headers(hit.headers)
    });
    response.headers.set('x-cotton-cache', 'HIT');
    return response;
  }

  const value = await producer();
  const response = json(value, 200, {
    'cache-control': `public, max-age=${clientTtl}, s-maxage=${ttl}, stale-while-revalidate=${Math.max(ttl, 3600)}`,
    'x-cotton-cache': 'MISS'
  });

  // Cache writes are best-effort; a cache write failure must never break the API.
  try {
    await cache.put(cacheKey, response.clone());
  } catch (error) {
    console.warn('Cache write failed', key, error);
  }

  return response;
}

function cottonYearPayloadFromRows(rows, year) {
  return {
    year,
    records: Object.fromEntries(rows.map(r => [r.geography_id, r])),
    diagnostics: { cotton_records: rows.length }
  };
}

async function cottonYearPayload(env, year) {
  const rows = await recordsForYear(env, year);
  return cottonYearPayloadFromRows(rows, year);
}

async function boundaryPayloadFromRows(rows) {
  const byCountry = new Map();

  for (const row of rows) {
    if (!row.country || !row.geography_id || !COUNTRY_BOUNDARIES[row.country]) continue;
    if (!byCountry.has(row.country)) byCountry.set(row.country, []);
    byCountry.get(row.country).push(row);
  }

  const parts = await Promise.all(
    [...byCountry.entries()].map(async ([country, countryRows]) => {
      try {
        return await openBoundaryLayer(country, countryRows);
      } catch (error) {
        console.error('Boundary load failed', country, error);
        return [];
      }
    })
  );

  const features = parts.flat();
  return {
    boundaries: { type: 'FeatureCollection', features },
    diagnostics: {
      cotton_geographies: rows.length,
      matched_boundaries: features.length,
      countries: [...byCountry.keys()]
    }
  };
}

async function boundaryPayload(env) {
  const rows = await geographyRows(env);
  return boundaryPayloadFromRows(rows);
}

function upstreamUrl(base, requestUrl) {
  const incoming = new URL(requestUrl);
  const target = new URL(base);
  for (const [key, value] of incoming.searchParams) {
    target.searchParams.append(key, value);
  }
  return target;
}

async function cachedUpstream(request, target, ttl = 1800) {
  return cached(request, `upstream:${target}`, async () => {
    const response = await fetch(target, { headers: { accept: 'application/json' } });
    if (!response.ok) throw new Error(`Upstream ${response.status}`);
    return response.json();
  }, ttl);
}

function coordinate(value, min, max) {
  const n = Number(value);
  return Number.isFinite(n) && n >= min && n <= max ? n : null;
}

function validYear(url) {
  const year = Number(url.searchParams.get('year'));
  return Number.isInteger(year) && year >= 1900 && year <= 2100 ? year : null;
}

function dataTtlForYear(year) {
  // Historical production data is effectively static, so keep it warm for a week.
  // Current/future-year records get a shorter TTL so updates appear the same day.
  const currentYear = new Date().getUTCFullYear();
  return year < currentYear ? 604800 : 21600;
}

async function handle(request, env) {
  const url = new URL(request.url);
  const route = url.pathname.replace(/^\/api\/?/, '');

  if (request.method !== 'GET') {
    return json({ error: 'Method not allowed' }, 405, { allow: 'GET' });
  }

  if (route === 'health') {
    return json({
      ok: true,
      storage: 'Notion cotton data only',
      boundaries: 'year-independent cotton geographies only'
    });
  }

  if (route === 'cotton/year') {
    const year = validYear(url);
    if (year === null) return json({ error: 'Invalid year' }, 400);
    return cached(request, `cotton-year:${year}`, () => cottonYearPayload(env, year), dataTtlForYear(year), 900);
  }

  if (route === 'boundaries') {
    return cached(
      request,
      'boundaries:cotton-geographies',
      () => boundaryPayload(env),
      2592000,
      86400
    );
  }

  if (route === 'map') {
    const year = validYear(url);
    if (year === null) return json({ error: 'Invalid year' }, 400);

    // Compatibility route only. New frontend requests stable geometry and year data separately.
    return cached(request, `map:${year}`, async () => {
      const [rows, boundaries] = await Promise.all([
        recordsForYear(env, year),
        boundaryPayload(env)
      ]);
      return { ...cottonYearPayloadFromRows(rows, year), ...boundaries };
    }, dataTtlForYear(year), 900);
  }

  if (route === 'cotton/profile') {
    const id = (url.searchParams.get('id') || '').trim();
    if (!id || id.length > 80) return json({ error: 'Invalid geography id' }, 400);

    return cached(request, `profile:${id}`, async () => {
      return queryNotion(
        env,
        {
          and: [
            recordTypeFilter('production'),
            { property: 'Geography ID', rich_text: { equals: id } }
          ]
        },
        [{ property: 'Year', direction: 'ascending' }]
      );
    }, 21600);
  }

  if (route === 'cotton/context') {
    return cached(request, 'cotton-context', async () => {
      const [seasons, issues] = await Promise.all([
        queryNotion(env, recordTypeFilter('growing_season')),
        queryNotion(env, recordTypeFilter('cotton_issue'))
      ]);
      return { seasons, issues };
    }, 21600);
  }

  const lat = coordinate(
    url.searchParams.get('latitude') ?? url.searchParams.get('lat'),
    -90,
    90
  );
  const lon = coordinate(
    url.searchParams.get('longitude') ?? url.searchParams.get('lon'),
    -180,
    180
  );

  if (
    ['weather/forecast', 'weather/seasonal', 'weather/climate', 'weather/archive', 'hazards'].includes(route) &&
    (lat === null || lon === null)
  ) {
    return json({ error: 'Invalid latitude or longitude' }, 400);
  }

  if (route === 'weather/forecast') {
    return cachedUpstream(
      request,
      upstreamUrl('https://api.open-meteo.com/v1/forecast', request.url),
      1800
    );
  }

  if (route === 'weather/seasonal') {
    return cachedUpstream(
      request,
      upstreamUrl('https://seasonal-api.open-meteo.com/v1/seasonal', request.url),
      21600
    );
  }

  if (route === 'weather/climate') {
    return cachedUpstream(
      request,
      upstreamUrl('https://climate-api.open-meteo.com/v1/climate', request.url),
      86400
    );
  }

  if (route === 'weather/archive') {
    return cachedUpstream(
      request,
      upstreamUrl('https://archive-api.open-meteo.com/v1/archive', request.url),
      86400
    );
  }

  if (route === 'hazards') {
    if (!env.HAZARD_API_URL || !env.HAZARD_API_KEY || !env.HAZARD_API_EMAIL) {
      return json({ error: 'Hazard API is not configured' }, 503);
    }

    const target = new URL(env.HAZARD_API_URL);
    target.searchParams.set('lat', String(lat));
    target.searchParams.set('lon', String(lon));
    target.searchParams.set('key', env.HAZARD_API_KEY);
    target.searchParams.set('email', env.HAZARD_API_EMAIL);

    return cachedUpstream(request, target, 86400);
  }

  return json({ error: 'Not found' }, 404);
}

export default {
  async fetch(request, env) {
    try {
      return await handle(request, env);
    } catch (error) {
      console.error(error);
      return json(
        {
          error: 'Server-side request failed'
        },
        500
      );
    }
  }
};
