# Cotton Risk Management - Notion Data Contract v5

Notion is the private source of truth. The public app must not depend on Notion latency for every interaction: Cloudflare caches API outputs, and stable boundaries are cached independently of year.

## Immediate compatible schema (single database)

The current database can remain one database during migration. Use these property names and types exactly.

| Property | Type | Required for | Notes |
|---|---|---|---|
| Name | Title | all | Unique record key, not a display label |
| Record Type | Rich text today; migrate to Select | all | `geography`, `production`, `growing_season`, `cotton_issue` |
| Geography ID | Rich text | geography, production, issues | Stable string ID; never Number because leading zeros matter |
| Country | Select or rich text | geography/production | Must match Worker country names exactly |
| State / Region | Rich text | geography/production | Parent administrative area |
| Local Area | Rich text | geography/production | Human-readable mapped area |
| Geography Type | Select | geography | county, district, municipality, department, province, region, state |
| Boundary ID | Rich text | geography | Preferred stable provider ID (US Census GEOID or geoBoundaries shapeID) |
| Boundary Name | Rich text | geography | Provider boundary name fallback; do not use as primary key |
| Year | Number | production/issues | Four-digit year |
| Planted Area (ha) | Number | production | hectares |
| Harvested Area (ha) | Number | production | optional but recommended |
| Yield (t/ha) | Number | production | metric used by map |
| Production (t) | Number | production | optional but recommended |
| Growing Season Start | Rich text | growing_season/geography | `MM-DD` |
| Growing Season End | Rich text | growing_season/geography | `MM-DD` |
| Cotton Pest / Issue | Rich text | cotton_issue | issue description |
| Source | Rich text | production/issues | source label |
| Source URL | URL | production/issues | source link |

## Required record keys

Use deterministic unique `Name` values:

- geography: `geo|USA|48115`
- production: `prod|USA|48115|2025`
- growing season: `season|USA|TX|48115`
- issue: `issue|USA|48115|2025|<short-code>`

This prevents duplicate rows from silently entering the database.

## Geography rows

Create exactly one `geography` row for each cotton-growing mapped area. Stable geometry metadata belongs here and never on yearly production rows.

Example:

- Record Type: geography
- Geography ID: 48115
- Country: United States
- State / Region: Texas
- Local Area: Dawson
- Geography Type: county
- Boundary ID: 48115
- Boundary Name: Dawson

The Worker prefers these rows for `/api/boundaries`. Until migration is complete it falls back to deduplicating production rows, so deployment can happen before the Notion cleanup is finished.

## Production rows

One row per Geography ID + Year. Do not duplicate descriptive geography metadata except the fields needed for human inspection. The unique key is `(Geography ID, Year)`.

Recommended validation rules outside Notion:

- Geography ID non-empty
- Year integer
- Planted Area >= 0
- Harvested Area >= 0
- Harvested Area <= Planted Area when both exist
- Yield >= 0
- no duplicate Geography ID + Year

## Longer-term normalized Notion layout

For maintainability, split the current mixed table into:

1. `Cotton Geographies` - stable geography and boundary mapping
2. `Cotton Production` - annual metrics, related to Cotton Geographies
3. `Cotton Issues` - annual/local issues, related to Cotton Geographies

Growing-season fields can live on Cotton Geographies when they are stable. If a geography needs multiple seasons, use a fourth `Cotton Growing Seasons` database.

The Worker is intentionally structured so the runtime API can later move from Notion to Cloudflare D1/R2 without changing the browser API contract.
