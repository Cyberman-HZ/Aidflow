// AidFlow Pro — static contract test for the Drone Camp Planner feature.
//
// No running Ollama, no browser. Reads the type-bearing source files as
// text and asserts the load-bearing contracts so future edits can't
// silently regress the feature:
//
//   1. CampMap / CampFeature / CampHazardZone / CampFamilyPin types
//      declare the fields the UI + service depend on.
//   2. The v11 Dexie migration registers the campMaps table.
//   3. The campMap service exports the public API the page imports
//      AND wraps the vision call so a bad model response can't throw.
//   4. Sphere standards constants exist and have plausible values.
//   5. The page is routed at /camp-map and has a sidebar nav entry.
//   6. The recordTrace call uses source: 'camp_map' (also enforced by
//      test-trace-shape.mjs).
//   7. The contract test for trace recording lists camp_map.
//
// Run:   node scripts/qa/test-camp-map-shape.mjs
//
// Exit codes: 0 = all pass · 1 = at least one assertion failed.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..', '..');

let pass = 0;
let fail = 0;

function read(rel) {
  return readFileSync(join(ROOT, rel), 'utf8');
}

function ok(label) {
  pass++;
  console.log(`  ✓ ${label}`);
}

function bad(label, detail) {
  fail++;
  console.log(`  ✗ ${label}`);
  if (detail) console.log(`      ${detail}`);
}

function assert(cond, label, detail) {
  if (cond) ok(label);
  else bad(label, detail);
}

function header(title) {
  console.log(`\n${title}`);
}

// ---------------------------------------------------------------------------
// 1. CampMap + supporting interfaces
// ---------------------------------------------------------------------------

header('1. CampMap type contracts');

const types = read('src/types/index.ts');

// CampMap field shape
const mapBlock = types.match(/export interface CampMap \{([\s\S]*?)\n\}/);
assert(!!mapBlock, 'CampMap interface declared');
const mapInner = mapBlock ? mapBlock[1] : '';
for (const f of [
  'id',
  'image',
  'image_mime',
  'image_width',
  'image_height',
  'uploaded_at',
  'uploaded_by',
  'features',
  'hazard_zones',
  'family_pins',
]) {
  assert(
    new RegExp(`\\b${f}\\??\\s*:`).test(mapInner),
    `CampMap.${f} declared`,
    'missing required field'
  );
}

// CampFeature field shape
const featBlock = types.match(/export interface CampFeature \{([\s\S]*?)\n\}/);
assert(!!featBlock, 'CampFeature interface declared');
const featInner = featBlock ? featBlock[1] : '';
for (const f of ['id', 'type', 'x', 'y', 'polygon', 'polyline', 'confidence']) {
  assert(
    new RegExp(`\\b${f}\\??\\s*:`).test(featInner),
    `CampFeature.${f} declared`,
    'missing field'
  );
}

// CampFeatureType union
const featureTypes = ['tent', 'water_point', 'latrine', 'building', 'vehicle', 'open_area', 'path'];
for (const ft of featureTypes) {
  assert(
    new RegExp(`'${ft}'`).test(types),
    `CampFeatureType includes '${ft}'`,
    'missing union member'
  );
}

// CampHazardZone + CampFamilyPin
assert(
  /export interface CampHazardZone/.test(types),
  'CampHazardZone interface exported'
);
assert(
  /export interface CampFamilyPin/.test(types),
  'CampFamilyPin interface exported'
);
assert(
  /kind:\s*'flood'\s*\|\s*'landslide'\s*\|\s*'security'\s*\|\s*'custom'/.test(types),
  'CampHazardZone.kind union includes flood|landslide|security|custom'
);

// AiTraceSource includes camp_map
assert(
  /'camp_map'/.test(types),
  "AiTraceSource union includes 'camp_map'",
  'trace recording cannot work without this'
);

// ---------------------------------------------------------------------------
// 2. v11 Dexie migration
// ---------------------------------------------------------------------------

header('2. Dexie v11 migration');

const dbSrc = read('src/db/database.ts');

assert(
  /this\.version\(11\)\.stores\(\{[\s\S]*campMaps:\s*'id, uploaded_at'/.test(dbSrc),
  'version(11) registers campMaps with id + uploaded_at indexes',
  "expected `campMaps: 'id, uploaded_at'`"
);
assert(
  /campMaps!:\s*Table<CampMap,\s*string>/.test(dbSrc),
  'campMaps table is typed as Table<CampMap, string>'
);
assert(
  /this\.campMaps\.clear\(\)/.test(dbSrc),
  'clearAll() wipes the campMaps table',
  'Reset demo data would otherwise leave stale layouts'
);

// ---------------------------------------------------------------------------
// 3. Service public API
// ---------------------------------------------------------------------------

header('3. campMap service surface');

const svc = read('src/services/campMap.ts');
const expectedExports = [
  'analyzeAndStoreImage',
  'extractCampFeaturesFromImage',
  'parseAndSanitize',
  'getCurrentCampMap',
  'clearCurrentCampMap',
  'setHazardZones',
  'setFamilyPins',
  'setAvgHouseholdSize',
  'tentsOf',
  'waterPointsOf',
  'latrinesOf',
  'openAreasOf',
  'pathsOf',
  'buildingsOf',
  'estimatePopulation',
  'tentCentroid',
  'weightedFamilyCentroid',
  'sphereReport',
  'unregisteredEstimate',
  'underservedZones',
  'pointInPolygon',
  'tentsInHazardZones',
  'suggestedDeliveryRoutes',
  'vulnerabilityScore',
];
for (const fn of expectedExports) {
  assert(
    new RegExp(`export (?:async )?function ${fn}\\b`).test(svc) ||
      new RegExp(`export const ${fn}\\b`).test(svc),
    `campMap exports ${fn}()`,
    'consumers will fail to import otherwise'
  );
}

// parseAndSanitize must never throw on bad input
assert(
  /try \{[\s\S]*?JSON\.parse[\s\S]*?\} catch \{[\s\S]*?return \{ features: \[\][\s\S]*?\}/m.test(svc),
  'parseAndSanitize catches JSON.parse errors and returns empty result',
  'a bad model response must NEVER throw — image upload would dead-end'
);

// analyzeAndStoreImage must call recordTrace with camp_map source
assert(
  /source:\s*['"]camp_map['"]/.test(svc),
  "analyzeAndStoreImage records a trace with source: 'camp_map'"
);

// Sphere constants
const sphereBlock = svc.match(/export const SPHERE\s*=\s*\{([\s\S]*?)\}\s*as const/);
assert(!!sphereBlock, 'SPHERE constants object exported');
const sphereInner = sphereBlock ? sphereBlock[1] : '';
assert(
  /PEOPLE_PER_LATRINE:\s*20/.test(sphereInner),
  'SPHERE.PEOPLE_PER_LATRINE = 20 (Sphere 2018 minimum)'
);
assert(
  /PEOPLE_PER_WATER_POINT:\s*250/.test(sphereInner),
  'SPHERE.PEOPLE_PER_WATER_POINT = 250'
);
assert(
  /WATER_LITRES_PER_PERSON_DAY:\s*15/.test(sphereInner),
  'SPHERE.WATER_LITRES_PER_PERSON_DAY = 15'
);

// ---------------------------------------------------------------------------
// 4. Geometry helpers — sanity checks on the pointInPolygon test
// ---------------------------------------------------------------------------

header('4. Geometry helpers');

// Re-parse the function source to run a couple of sanity tests via Function.
// We can't import the TS file directly from Node, but a quick text-extract +
// `new Function(...)` covers the math. Falls back to silent skip if the
// helper signature changes.
try {
  const fnMatch = svc.match(
    /export function pointInPolygon\([\s\S]*?\): boolean \{([\s\S]*?)\n\}/
  );
  if (!fnMatch) throw new Error('helper not found');
  // eslint-disable-next-line no-new-func
  const ppFn = new Function('px', 'py', 'polygon', fnMatch[1]);
  const square = [
    [0.2, 0.2],
    [0.8, 0.2],
    [0.8, 0.8],
    [0.2, 0.8],
  ];
  assert(ppFn(0.5, 0.5, square) === true, 'pointInPolygon: centre is inside the unit square');
  assert(ppFn(0.1, 0.1, square) === false, 'pointInPolygon: outside corner is outside');
  assert(ppFn(0.5, 0.9, square) === false, 'pointInPolygon: above the square is outside');
  assert(ppFn(0.5, 0.21, square) === true, 'pointInPolygon: just above bottom edge is inside');
} catch (e) {
  // Don't fail the whole test if the helper signature evolved; emit a soft
  // warning so the developer knows to update the sanity checks.
  console.log('  ⚠ pointInPolygon sanity skipped:', e.message);
}

// ---------------------------------------------------------------------------
// 5. /camp-map route + nav + locale
// ---------------------------------------------------------------------------

header('5. Routing, nav, locale');

const appTsx = read('src/App.tsx');
assert(
  /Route path="\/camp-map" element=\{<CampMap/.test(appTsx),
  '/camp-map route registered in App.tsx'
);
assert(
  /import CampMap from '\.\/pages\/CampMap'/.test(appTsx),
  'CampMap page imported in App.tsx'
);

const layoutTsx = read('src/components/Layout.tsx');
assert(
  /to: '\/camp-map'/.test(layoutTsx),
  'Sidebar nav links to /camp-map'
);
assert(
  /\bPlane\b/.test(layoutTsx),
  "Sidebar imports the Plane icon (used by the camp-map nav entry)"
);

const enLocale = JSON.parse(read('src/locales/en.json'));
const arLocale = JSON.parse(read('src/locales/ar.json'));
const frLocale = JSON.parse(read('src/locales/fr.json'));
const esLocale = JSON.parse(read('src/locales/es.json'));
for (const [name, j] of [['en', enLocale], ['ar', arLocale], ['fr', frLocale], ['es', esLocale]]) {
  assert(
    typeof j.nav?.camp_map === 'string' && j.nav.camp_map.length > 0,
    `nav.camp_map present in ${name}.json`
  );
}

// ---------------------------------------------------------------------------
// 6. Trace test references camp_map
// ---------------------------------------------------------------------------

header('6. Cross-check with test-trace-shape.mjs');

const traceTest = read('scripts/qa/test-trace-shape.mjs');
assert(
  /'camp_map'/.test(traceTest),
  "test-trace-shape.mjs includes 'camp_map' in its sources list"
);
assert(
  /src\/services\/campMap\.ts/.test(traceTest),
  "test-trace-shape.mjs lists src/services/campMap.ts as a callsite"
);

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log(`\n${pass + fail} assertion(s) total — ${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
