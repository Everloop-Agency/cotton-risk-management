# Cotton Risk Management v5 refactor

This patch replaces `src/worker.js` and `public/js/app.js` and adds a Notion schema contract.

## Runtime architecture

1. `/api/boundaries` loads year-independent geometry for cotton geographies only and is cached for 30 days.
2. `/api/cotton/year?year=YYYY` returns only annual cotton values and uses longer cache for historical years.
3. The browser creates the Leaflet geometry once and only restyles it when the year or metric changes.
4. Year payloads are deduplicated in memory and all remaining years are prefetched gradually while idle.
5. Playback waits for each year to finish before scheduling the next one, preventing overlapping requests.
6. `/api/map` remains only for backward compatibility.

## Notion migration

Read `docs/NOTION_SCHEMA.md`. The preferred model adds one stable `geography` row per mapped area with `Boundary ID` and `Boundary Name`. Until those rows exist, the Worker falls back to deduplicating existing production rows, so migration is non-breaking.

## Validation

Run:

```bash
npm run check
```

Before deploy, keep the existing `wrangler.jsonc`, static assets, CSS, and secret configuration from the repository.
