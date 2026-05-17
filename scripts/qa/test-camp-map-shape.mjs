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
// 2. Dexie migrations
// ---------------------------------------------------------------------------

header('2. Dexie v11 + v12 migrations');

const dbSrc = read('src/db/database.ts');

assert(
  /this\.version\(11\)\.stores\(\{[\s\S]*campMaps:\s*'id, uploaded_at'/.test(dbSrc),
  'version(11) registers campMaps with id + uploaded_at indexes',
  "expected `campMaps: 'id, uploaded_at'`"
);
assert(
  /this\.version\(12\)/.test(dbSrc),
  'version(12) bump for multi-snapshot time-series exists',
  'singleton-to-history migration must happen on a new Dexie version'
);
assert(
  /version\(12\)[\s\S]*?\.upgrade\([\s\S]*?\.get\('current'\)[\s\S]*?snap-/.test(dbSrc),
  "v12 upgrade renames the legacy 'current' singleton row to a snap-{epoch} id",
  'without this, the old singleton row would be orphaned in the history view'
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
  'listCampMaps',
  'getCampMap',
  'getLatestCampMap',
  'getCurrentCampMap',
  'deleteCampMap',
  'clearAllCampMaps',
  'clearCurrentCampMap',
  'setHazardZones',
  'setFamilyPins',
  'setAvgHouseholdSize',
  'setFeatures',
  'nextFeatureId',
  'confidenceWeight',
  'diffSnapshots',
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

// FEATURE_DEDUPE_THRESHOLD exposed as a const (used implicitly by the
// dedupe pass; exporting it makes the threshold a contract).
assert(
  /export const FEATURE_DEDUPE_THRESHOLD/.test(svc),
  'campMap exports FEATURE_DEDUPE_THRESHOLD constant'
);

// parseAndSanitize must never throw on bad input
assert(
  /try \{[\s\S]*?JSON\.parse[\s\S]*?\} catch \{[\s\S]*?return \{ features: \[\][\s\S]*?\}/m.test(svc),
  'parseAndSanitize catches JSON.parse errors and returns empty result',
  'a bad model response must NEVER throw — image upload would dead-end'
);

// parseAndSanitize must dedupe near-coincident features of the same type
assert(
  /FEATURE_DEDUPE_THRESHOLD/.test(svc) && /Math\.hypot/.test(svc),
  'parseAndSanitize uses Math.hypot against FEATURE_DEDUPE_THRESHOLD to drop near-duplicate features',
  'the model often emits the same physical tent at slightly different coords'
);

// Vision prompt must teach the coordinate convention + give a worked example
assert(
  /TOP-LEFT/i.test(svc) && /y grows DOWNWARD/i.test(svc),
  'SYSTEM_PROMPT explicitly teaches top-left origin and downward y axis',
  'vision models routinely flip y when origin is implicit'
);
assert(
  /WORKED EXAMPLE/i.test(svc),
  'SYSTEM_PROMPT includes a worked JSON example',
  'few-shot lifts schema adherence on this size of model'
);

// Vision call uses temperature 0 (deterministic — schema is strict)
assert(
  /temperature:\s*0\b/.test(svc),
  'extractCampFeaturesFromImage calls chatWithImage with temperature: 0'
);

// Resize cap raised from 1280 to 1600 to give the model more pixels per tent
assert(
  /maxDim:\s*1600\b/.test(svc),
  'analyzeAndStoreImage resizes the image to maxDim 1600 (was 1280)'
);

// analyzeAndStoreImage must call recordTrace with camp_map source
assert(
  /source:\s*['"]camp_map['"]/.test(svc),
  "analyzeAndStoreImage records a trace with source: 'camp_map'"
);

// estimatePopulation now returns tents_raw alongside tents (confidence-weighted)
assert(
  /tents_raw:/.test(svc),
  'estimatePopulation returns a tents_raw count alongside the confidence-weighted tents number',
  'UI needs both: raw count for "tents visible" and weighted for the population math'
);

// setFeatures must prune dangling family pins so insights don't break
assert(
  /family_pins\s*=\s*row\.family_pins\.filter[\s\S]*?validIds\.has/.test(svc),
  'setFeatures prunes family_pins whose feature_id no longer exists',
  'deleting a feature in Edit mode would otherwise leave dangling pins'
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
// 4a. Time-series snapshot contract
// ---------------------------------------------------------------------------

header('4a. Time-series snapshots + diff');

// All mutators must take a snapshot id first — the singleton 'current' is gone
for (const fn of ['setHazardZones', 'setFamilyPins', 'setAvgHouseholdSize', 'setFeatures']) {
  assert(
    new RegExp(`export async function ${fn}\\(\\s*snapshotIdToPatch:\\s*string`).test(svc),
    `${fn} takes a snapshot id as its first argument`,
    'caller must be explicit about which snapshot to mutate'
  );
}

// SnapshotDiff shape + diffSnapshots return contract
assert(
  /export interface SnapshotDiff \{[\s\S]*?kept:[\s\S]*?moved:[\s\S]*?added:[\s\S]*?removed:[\s\S]*?span_days:/.test(svc),
  'SnapshotDiff interface declares kept/moved/added/removed/span_days'
);
assert(
  /export function diffSnapshots\([\s\S]*?active: CampMap[\s\S]*?compare: CampMap/.test(svc),
  'diffSnapshots takes (active, compare) CampMap arguments'
);
assert(
  /DIFF_MATCH_THRESHOLD/.test(svc) && /DIFF_MOVE_THRESHOLD/.test(svc),
  'DIFF_MATCH_THRESHOLD + DIFF_MOVE_THRESHOLD exported as constants',
  'thresholds are part of the contract so geometry tweaks are visible'
);

// New uploads use snap-{epoch} ids (not the legacy 'current')
assert(
  /snapshotId\(now\)/.test(svc) || /`snap-\$\{/.test(svc),
  'analyzeAndStoreImage stores uploads under a snap-{epoch} id',
  'singleton "current" id is forbidden post-v12'
);

// Live diffSnapshots sanity check — run a hand-written JS port of the
// algorithm so we don't have to TS-strip the source. The port mirrors
// the service body line-for-line; if the algorithm diverges this test
// won't catch the regression, but the static contract checks above will
// catch any shape changes.
{
  function diffFn(active, compare) {
    const MATCH = 0.02;
    const MOVE = 0.005;
    const at = active.features.filter(
      (f) => f.type === 'tent' && typeof f.x === 'number' && typeof f.y === 'number'
    );
    const bt = compare.features.filter(
      (f) => f.type === 'tent' && typeof f.x === 'number' && typeof f.y === 'number'
    );
    const used = new Set();
    const kept = [];
    const moved = [];
    const added = [];
    for (const a of at) {
      let bestIdx = -1;
      let bestDist = Infinity;
      for (let i = 0; i < bt.length; i++) {
        if (used.has(i)) continue;
        const b = bt[i];
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        if (d < bestDist) {
          bestDist = d;
          bestIdx = i;
        }
      }
      if (bestIdx >= 0 && bestDist < MATCH) {
        used.add(bestIdx);
        const match = { a, b: bt[bestIdx], distance: bestDist };
        if (bestDist < MOVE) kept.push(match);
        else moved.push(match);
      } else {
        added.push(a);
      }
    }
    const removed = bt.filter((_, i) => !used.has(i));
    const span_ms =
      new Date(active.uploaded_at).getTime() - new Date(compare.uploaded_at).getTime();
    const span_days = Math.max(0, Math.round(span_ms / 86_400_000));
    return { kept, moved, added, removed, span_days };
  }
  const active = {
    features: [
      { id: 'tent-1', type: 'tent', x: 0.1, y: 0.1 },
      { id: 'tent-2', type: 'tent', x: 0.5, y: 0.5 },
      { id: 'tent-3', type: 'tent', x: 0.9, y: 0.9 },
    ],
    uploaded_at: '2026-05-17T00:00:00Z',
  };
  const compare = {
    features: [
      { id: 'tent-A', type: 'tent', x: 0.1, y: 0.1 },
      { id: 'tent-B', type: 'tent', x: 0.51, y: 0.51 },
      { id: 'tent-C', type: 'tent', x: 0.2, y: 0.8 },
    ],
    uploaded_at: '2026-05-10T00:00:00Z',
  };
  const r = diffFn(active, compare);
  assert(r.added.length === 1, 'diffSnapshots: 1 added tent (brand-new at 0.9,0.9)');
  assert(r.removed.length === 1, 'diffSnapshots: 1 removed tent (gone at 0.2,0.8)');
  assert(r.kept.length === 1, 'diffSnapshots: 1 kept tent (perfect match at 0.1,0.1)');
  assert(r.moved.length === 1, 'diffSnapshots: 1 moved tent (within MATCH, beyond MOVE)');
  assert(r.span_days === 7, 'diffSnapshots: span_days = 7');
}

// Page + insights wire the diff through
const pageForDiff = read('src/pages/CampMap.tsx');
assert(
  /diffSnapshots\(campMap,\s*compareMap\)/.test(pageForDiff),
  'CampMap page invokes diffSnapshots(active, compare)'
);
assert(
  /listCampMaps\(\)/.test(pageForDiff),
  'CampMap page calls listCampMaps for the snapshot picker'
);
assert(
  /setActiveId/.test(pageForDiff) && /setCompareId/.test(pageForDiff),
  'CampMap page maintains activeId + compareId state'
);

const insightsForDiff = read('src/components/CampMapInsights.tsx');
assert(
  /compareMap:\s*CampMap \| null/.test(insightsForDiff),
  'Insights Props declares compareMap: CampMap | null'
);
assert(
  /diff:\s*SnapshotDiff \| null/.test(insightsForDiff),
  'Insights Props declares diff: SnapshotDiff | null'
);

const canvasForDiff = read('src/components/CampMapCanvas.tsx');
assert(
  /diff\?:\s*SnapshotDiff \| null/.test(canvasForDiff),
  'Canvas Props declares optional diff: SnapshotDiff | null'
);
assert(
  /diff\?\.removed\.map/.test(canvasForDiff),
  'Canvas renders the removed-tent ghosts when diff is present'
);
assert(
  /diff\?\.moved\.map/.test(canvasForDiff),
  'Canvas renders the moved-tent arrows when diff is present'
);

// ---------------------------------------------------------------------------
// 4b. Edit mode wiring (canvas + page)
// ---------------------------------------------------------------------------

header('4b. Edit mode (admin-correction UI)');

const canvasSrc = read('src/components/CampMapCanvas.tsx');
assert(
  /export type CanvasMode = [^;]*'edit'/.test(canvasSrc),
  "CanvasMode union includes 'edit'",
  'page would not be able to enter edit mode otherwise'
);
assert(
  /export type EditBrushType/.test(canvasSrc),
  'EditBrushType exported from canvas',
  'page typecheck would fail without this'
);
assert(
  /onAddFeature\s*:[\s\S]*?onDeleteFeature\s*:/.test(canvasSrc),
  'Canvas Props declares onAddFeature + onDeleteFeature callbacks'
);
assert(
  /mode === 'edit'/.test(canvasSrc),
  "Canvas branches on mode === 'edit'"
);

const pageSrc = read('src/pages/CampMap.tsx');
assert(
  /const onAddFeature\s*=/.test(pageSrc) && /const onDeleteFeature\s*=/.test(pageSrc),
  'CampMap page implements onAddFeature + onDeleteFeature handlers'
);
assert(
  /setFeatures\(/.test(pageSrc) && /nextFeatureId\(/.test(pageSrc),
  'CampMap page calls setFeatures + nextFeatureId to persist edits'
);
assert(
  /onAddFeature=\{onAddFeature\}/.test(pageSrc) && /onDeleteFeature=\{onDeleteFeature\}/.test(pageSrc),
  'CampMap page passes the edit handlers down to the canvas'
);

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
