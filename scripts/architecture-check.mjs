import fs from 'node:fs';
const app = fs.readFileSync('public/js/app.js','utf8');
const worker = fs.readFileSync('src/worker.js','utf8');
const failures = [];
if (app.includes('/map?year=')) failures.push('Frontend must not use /api/map for year changes');
if (!app.includes("apiJson('/boundaries'")) failures.push('Frontend must load stable boundaries independently');
if (!app.includes('/cotton/year?year=')) failures.push('Frontend must request year-only production payloads');
const boundaryRoute = worker.match(/if \(route === 'boundaries'\) \{[\s\S]*?\n  \}/)?.[0] || '';
if (/validYear|searchParams\.get\('year'\)/.test(boundaryRoute)) failures.push('/api/boundaries must not depend on year');
if (!worker.includes("recordTypeFilter('production')")) failures.push('Production queries must filter record type server-side');
if (!worker.includes('GEOID IN')) failures.push('US Census query should request cotton GEOIDs only');
if (failures.length) { console.error(failures.join('\n')); process.exit(1); }
console.log('OK: v5 architecture invariants passed');
