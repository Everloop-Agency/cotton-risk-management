# US Cotton Climate Anomaly Bundle

Webapp-ready static dataset for 29,880 city records mapped to 3,353 NASA POWER grid cells.

## Lookup
1. Load `locations.json` and find the city record.
2. Read its `grid_id`.
3. Load `grids/{grid_id}.json`.
4. Use array ordering documented in `manifest.json`.

Only one grid file is needed per selected city. Relative anomalies are fractions (0.25 = +25%).

## Partial SSP5-8.5 projections
Projection fields use a stable null-filled schema when unavailable. Always check `grid.projections.coverage_status`. Coverage counts are recorded in `manifest.json`.
