// QA regression suite for the Smart CSV/Excel import feature.
// Tests pure logic (heuristic mapping, AI-JSON parsing, row coercion)
// plus invariants on the source file (offline guarantees, no rogue
// fetch / network calls, family_id excluded from the mapping allowlist).
//
// Run with: node scripts/qa/test-spreadsheet-import.mjs

import { readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..', '..');
const read = (p) => readFileSync(resolve(root, p), 'utf8');
const sizeOf = (p) => {
  try { return statSync(resolve(root, p)).size; }
  catch { return 0; }
};

const importSrc = (() => {
  try { return read('src/services/spreadsheetImport.ts'); }
  catch { return ''; }
})();
const modalSrc = (() => {
  try { return read('src/components/SpreadsheetImportModal.tsx'); }
  catch { return ''; }
})();
const familiesSrc = (() => {
  try { return read('src/pages/Families.tsx'); }
  catch { return ''; }
})();
const STALE = sizeOf('src/services/spreadsheetImport.ts') < 5000;
if (STALE) {
  console.log('INFO: workspace mount appears stale; source-regex sniffs may report incorrectly.');
}

let passed = 0;
let failed = 0;
const fail = (msg) => { console.log(`FAIL: ${msg}`); failed++; };
const ok = (msg) => { console.log(`PASS: ${msg}`); passed++; };
const expect = (cond, msg) => (cond ? ok(msg) : fail(msg));
const expectEq = (actual, expected, msg) => {
  if (JSON.stringify(actual) === JSON.stringify(expected)) ok(msg);
  else { fail(`${msg}\n     expected: ${JSON.stringify(expected)}\n     actual:   ${JSON.stringify(actual)}`); }
};

// =========================================================================
// 1. Source-file invariants — offline + correctness
// =========================================================================

console.log('\n--- Source invariants ---\n');

// 1a. family_id must NOT appear in IMPORTABLE_FIELDS — IDs are system-generated.
expect(
  /export const IMPORTABLE_FIELDS:\s*ImportableFamilyField\[\]\s*=\s*\[([^\]]*)\]/.test(importSrc) &&
    !/IMPORTABLE_FIELDS[^\]]*family_id/.test(importSrc),
  'family_id is excluded from IMPORTABLE_FIELDS (system-generated only)'
);

// 1b. The mapping system prompt must explicitly forbid family_id.
expect(
  /DO NOT map any column to "family_id"/.test(importSrc),
  'AI mapping system prompt explicitly forbids family_id mapping'
);

// 1c. No raw fetch( call inside spreadsheetImport.ts — all AI calls go via the
//     existing chat() helper, which routes to local Ollama. This is the
//     offline-first invariant.
expect(
  !/^[^/]*fetch\(/m.test(importSrc.replace(/\/\/[^\n]*/g, '')),
  'No bare fetch() in spreadsheetImport.ts (offline-only via chat() helper)'
);

// 1d. The chat helper IS imported (so we know AI calls are routed through it).
expect(
  /from\s+['"]@\/services\/ollama['"]/.test(importSrc) &&
    /\bchat\b/.test(importSrc),
  'spreadsheetImport.ts imports chat() from ollama service'
);

// 1e. PapaParse and dynamic xlsx import are wired.
expect(/import Papa from ['"]papaparse['"]/.test(importSrc), 'PapaParse is imported');
expect(
  /await\s+import\(\s*['"]xlsx['"]\s*\)/.test(importSrc),
  'xlsx is dynamically imported (lazy-loaded)'
);

// 1f. UI button is wired in Families.tsx.
expect(
  /SpreadsheetImportModal/.test(familiesSrc) &&
    /setImportOpen\(true\)/.test(familiesSrc),
  'Families.tsx wires the SpreadsheetImportModal'
);

// 1g. Modal locks body scroll & listens for Escape (a11y).
expect(
  /document\.body\.style\.overflow\s*=\s*['"]hidden['"]/.test(modalSrc) &&
    /['"]Escape['"]/.test(modalSrc) &&
    /addEventListener\(\s*['"]keydown['"]/.test(modalSrc),
  'SpreadsheetImportModal a11y: body-scroll lock + Escape handler'
);

// =========================================================================
// 2. Pure-logic tests — re-implement minimal versions inline so we don't
//    have to set up tsx / a real test runner. These mirror what the real
//    service does so we can assert invariants offline.
// =========================================================================

console.log('\n--- Heuristic mapping ---\n');

// Re-implementation of the heuristic mapper kept in lockstep with the
// FIELD_SYNONYMS table in src/services/spreadsheetImport.ts. If you add
// synonyms there, mirror them here so this test stays meaningful.
const FIELD_SYNONYMS = {
  head_name: ['head of household', 'head of family', 'head_name', 'household head', 'hoh', 'head', 'name', 'full name', 'family name', 'beneficiary name', 'main contact'],
  member_count: ['household size', 'family size', 'member count', 'total members', 'people', 'persons', 'individuals', 'hh size'],
  children_under_5: ['children under 5', 'kids under 5', 'under 5', 'u5', 'infants', 'young children'],
  elderly_count: ['elderly', '65+', '60+', 'seniors', 'older adults', 'aged'],
  has_pregnant_member: ['pregnant', 'pregnancy', 'pregnant woman', 'expecting'],
  medical_conditions: ['medical conditions', 'medical', 'conditions', 'illness', 'health issues', 'chronic conditions', 'diseases'],
  displacement_status: ['displacement', 'displacement status', 'status', 'idp', 'refugee status', 'displaced', 'situation'],
  income_level: ['income', 'income level', 'monthly income', 'income bracket', 'wealth'],
  location_sector: ['sector', 'camp', 'location', 'area', 'zone', 'site', 'district', 'sub-district', 'block', 'cluster'],
  street: ['street', 'address', 'street address', 'house', 'house no'],
  city: ['city', 'town', 'village', 'municipality'],
  notes: ['notes', 'comments', 'remarks', 'observations', 'note'],
};
const FIELDS = Object.keys(FIELD_SYNONYMS);

function normalizeHeader(h) {
  return String(h ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9+]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function heuristicMapping(headers) {
  const mapping = {};
  for (const h of headers) mapping[h] = null;
  const taken = new Set();
  for (const field of FIELDS) {
    const syns = FIELD_SYNONYMS[field];
    let best = null;
    for (const h of headers) {
      if (taken.has(h)) continue;
      const norm = normalizeHeader(h);
      if (!norm) continue;
      for (const syn of syns) {
        const sn = normalizeHeader(syn);
        if (!sn) continue;
        if (norm === sn || norm.includes(sn) || sn.includes(norm)) {
          if (!best || sn.length > best.matched.length) {
            best = { header: h, matched: sn };
          }
        }
      }
    }
    if (best) {
      mapping[best.header] = field;
      taken.add(best.header);
    }
  }
  return mapping;
}

// 2a. Direct, obvious headers — the most common case. Each should map
//     unambiguously without ever touching Gemma 4.
{
  const headers = [
    'Head of Household',
    'Total Members',
    'Children under 5',
    'Sector',
    'Phone Number',
    'NGO Reference Number',
  ];
  const m = heuristicMapping(headers);
  expectEq(m['Head of Household'], 'head_name', 'heuristic: "Head of Household" → head_name');
  expectEq(m['Total Members'], 'member_count', 'heuristic: "Total Members" → member_count');
  expectEq(m['Children under 5'], 'children_under_5', 'heuristic: "Children under 5" → children_under_5');
  expectEq(m['Sector'], 'location_sector', 'heuristic: "Sector" → location_sector');
  expectEq(m['NGO Reference Number'], null, 'heuristic: "NGO Reference Number" → null (will go to notes)');
}

// 2b. Each Family field can be the target of AT MOST ONE column — when two
//     headers plausibly match the same field, only one wins.
{
  const headers = ['Sector', 'Camp', 'Zone'];
  const m = heuristicMapping(headers);
  const targets = Object.values(m).filter((v) => v === 'location_sector');
  expect(
    targets.length === 1,
    'heuristic: at most one column maps to location_sector even when 3 are plausible'
  );
}

// 2c. Empty / fully unknown headers — nothing maps, nothing crashes.
{
  const headers = ['Foo', 'Bar', 'Baz'];
  const m = heuristicMapping(headers);
  const allNull = Object.values(m).every((v) => v === null);
  expect(allNull, 'heuristic: completely unknown headers all map to null');
}

// 2d. "Address" should map to street (matches synonym "street address").
{
  const headers = ['Address'];
  const m = heuristicMapping(headers);
  expectEq(m['Address'], 'street', 'heuristic: "Address" → street');
}

// =========================================================================
// 3. Type / enum coercion
// =========================================================================

console.log('\n--- Coercion ---\n');

const TRUTHY = new Set(['yes', 'y', 'true', 't', '1', 'oui', 'sí', 'si', 'pregnant', 'p']);
const FALSY = new Set(['no', 'n', 'false', 'f', '0', 'non', '']);

function coerceBoolean(v) {
  const s = String(v ?? '').trim().toLowerCase();
  if (TRUTHY.has(s)) return true;
  if (FALSY.has(s)) return false;
  return s.length > 0;
}

function coerceInteger(v, def = 0) {
  if (!v) return def;
  const n = Number(String(v).replace(/[^0-9.\-]/g, ''));
  if (!Number.isFinite(n)) return def;
  return Math.max(0, Math.floor(n));
}

const DISPLACEMENT_SYNONYMS = {
  'resident': 'resident',
  'host': 'resident',
  'host community': 'resident',
  'local': 'resident',
  'stable': 'resident',
  'recently_displaced': 'recently_displaced',
  'recently displaced': 'recently_displaced',
  'displaced': 'recently_displaced',
  'idp': 'recently_displaced',
  'internally displaced': 'recently_displaced',
  'refugee': 'refugee',
  'asylum': 'refugee',
};

function coerceDisplacement(v) {
  const k = String(v ?? '').trim().toLowerCase();
  return DISPLACEMENT_SYNONYMS[k] ?? 'resident';
}

const INCOME_SYNONYMS = {
  'none': 'none', 'no income': 'none', 'zero': 'none', '0': 'none',
  'minimal': 'minimal', 'low': 'minimal', 'very low': 'minimal', 'poor': 'minimal',
  'moderate': 'moderate', 'medium': 'moderate', 'middle': 'moderate', 'stable': 'moderate', 'ok': 'moderate',
};

function coerceIncome(v) {
  const k = String(v ?? '').trim().toLowerCase();
  return INCOME_SYNONYMS[k] ?? 'minimal';
}

function coerceMedical(v) {
  if (!v) return [];
  return String(v).split(/[,;\n]+/).map((s) => s.trim()).filter(Boolean);
}

// 3a. Booleans
expect(coerceBoolean('yes') === true, 'coerce: "yes" → true');
expect(coerceBoolean('No') === false, 'coerce: "No" → false');
expect(coerceBoolean('1') === true, 'coerce: "1" → true');
expect(coerceBoolean('0') === false, 'coerce: "0" → false');
expect(coerceBoolean('') === false, 'coerce: "" → false');
expect(coerceBoolean('Pregnant — confirmed') === true, 'coerce: free-text non-falsy → true');

// 3b. Integers
expectEq(coerceInteger('5'), 5, 'coerce: "5" → 5');
expectEq(coerceInteger('5 people'), 5, 'coerce: "5 people" → 5 (strips text)');
expectEq(coerceInteger(''), 0, 'coerce: empty → 0');
expectEq(coerceInteger('not-a-number', 1), 1, 'coerce: garbage → default');
expectEq(coerceInteger('-3'), 0, 'coerce: negative → 0 (clamped)');

// 3c. Displacement enum
expectEq(coerceDisplacement('IDP'), 'recently_displaced', 'coerce: "IDP" → recently_displaced');
expectEq(coerceDisplacement('Host community'), 'resident', 'coerce: "Host community" → resident');
expectEq(coerceDisplacement('refugee'), 'refugee', 'coerce: "refugee" → refugee');
expectEq(coerceDisplacement(''), 'resident', 'coerce: empty displacement → "resident" (default)');
expectEq(coerceDisplacement('something_weird'), 'resident', 'coerce: unknown displacement → "resident"');

// 3d. Income enum
expectEq(coerceIncome('No income'), 'none', 'coerce: "No income" → none');
expectEq(coerceIncome('Low'), 'minimal', 'coerce: "Low" → minimal');
expectEq(coerceIncome('moderate'), 'moderate', 'coerce: "moderate" → moderate');
expectEq(coerceIncome(''), 'minimal', 'coerce: empty income → "minimal" (default)');

// 3e. Medical conditions list
expectEq(coerceMedical('diabetes, hypertension'), ['diabetes', 'hypertension'], 'coerce: comma-list → array');
expectEq(coerceMedical('asthma; chronic kidney disease'), ['asthma', 'chronic kidney disease'], 'coerce: semicolon-list → array');
expectEq(coerceMedical(''), [], 'coerce: empty medical → []');
expectEq(coerceMedical('one,, two ,'), ['one', 'two'], 'coerce: drops empty entries');

// =========================================================================
// 4. AI mapping JSON parser — survives garbage gracefully
// =========================================================================

console.log('\n--- AI JSON parser ---\n');

// Re-implement the defensive JSON parser inline. Mirror of the real one.
const VALID_FIELDS = new Set([
  'head_name', 'member_count', 'children_under_5', 'elderly_count',
  'has_pregnant_member', 'medical_conditions', 'displacement_status',
  'income_level', 'location_sector', 'street', 'city', 'notes',
]);

function parseMappingJson(raw, headers) {
  if (!raw || !raw.trim()) return null;
  let text = raw.trim();
  text = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '');
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  const slice = text.slice(start, end + 1);
  let parsed;
  try { parsed = JSON.parse(slice); } catch { return null; }
  if (!parsed || typeof parsed !== 'object') return null;
  const rawMapping = parsed.mapping ?? {};
  const mapping = {};
  const used = new Set();
  for (const h of headers) {
    const v = rawMapping[h];
    let field = null;
    if (typeof v === 'string' && VALID_FIELDS.has(v)) {
      field = v;
      if (used.has(field)) field = null;
      else used.add(field);
    }
    mapping[h] = field;
  }
  const anyMapped = Object.values(mapping).some((v) => v !== null);
  if (!anyMapped) return null;
  return { mapping };
}

// 4a. Clean JSON parses cleanly.
{
  const raw = JSON.stringify({
    mapping: { 'Head': 'head_name', 'Sector': 'location_sector', 'Junk': null },
    reasoning: { 'Head': 'ok', 'Sector': 'ok', 'Junk': 'no match' },
  });
  const result = parseMappingJson(raw, ['Head', 'Sector', 'Junk']);
  expect(result !== null, 'parser: clean JSON returns a mapping');
  expectEq(result?.mapping?.Head, 'head_name', 'parser: Head → head_name');
  expectEq(result?.mapping?.Junk, null, 'parser: Junk → null preserved');
}

// 4b. Markdown code-fenced JSON is unwrapped.
{
  const raw = '```json\n' + JSON.stringify({
    mapping: { 'A': 'head_name' },
    reasoning: { 'A': 'ok' },
  }) + '\n```';
  const result = parseMappingJson(raw, ['A']);
  expect(result !== null, 'parser: code-fenced JSON parses (fence stripped)');
}

// 4c. Garbage / non-JSON returns null (caller falls back to heuristic).
{
  expect(parseMappingJson('not json at all', ['A']) === null, 'parser: non-JSON → null');
  expect(parseMappingJson('', ['A']) === null, 'parser: empty → null');
  expect(parseMappingJson('{broken json', ['A']) === null, 'parser: broken JSON → null');
}

// 4d. Invalid field values are filtered out.
{
  const raw = JSON.stringify({
    mapping: { 'A': 'head_name', 'B': 'INVALID_FIELD', 'C': 42 },
    reasoning: {},
  });
  const result = parseMappingJson(raw, ['A', 'B', 'C']);
  expect(result !== null, 'parser: tolerates invalid field values');
  expectEq(result?.mapping?.A, 'head_name', 'parser: A → head_name');
  expectEq(result?.mapping?.B, null, 'parser: B (invalid field name) → null');
  expectEq(result?.mapping?.C, null, 'parser: C (non-string) → null');
}

// 4e. Duplicate-field claims — only the first wins.
{
  const raw = JSON.stringify({
    mapping: { 'A': 'location_sector', 'B': 'location_sector' },
    reasoning: {},
  });
  const result = parseMappingJson(raw, ['A', 'B']);
  expectEq(result?.mapping?.A, 'location_sector', 'parser: first claim of location_sector wins');
  expectEq(result?.mapping?.B, null, 'parser: duplicate claim falls to null');
}

// 4f. All-null mapping returns null so caller falls back to heuristic.
{
  const raw = JSON.stringify({
    mapping: { 'A': null, 'B': null },
    reasoning: {},
  });
  const result = parseMappingJson(raw, ['A', 'B']);
  expect(result === null, 'parser: all-null mapping → null (heuristic fallback)');
}

// =========================================================================
// 5. Locale parity — every locale has the import block
// =========================================================================

console.log('\n--- Locale parity ---\n');

for (const lang of ['en', 'ar', 'fr', 'es']) {
  let parsed;
  try { parsed = JSON.parse(read(`src/locales/${lang}.json`)); }
  catch (e) { fail(`${lang}.json could not be parsed: ${e.message}`); continue; }
  expect(parsed.import, `locales/${lang}.json has the "import" block`);
  expect(parsed.import?.title, `locales/${lang}.json has import.title`);
  expect(parsed.import?.button_label, `locales/${lang}.json has import.button_label`);
  expect(parsed.common?.next, `locales/${lang}.json has common.next`);
  expect(parsed.common?.done, `locales/${lang}.json has common.done`);
}

// =========================================================================
// Summary
// =========================================================================

console.log(`\n--- ${passed + failed} tests, ${passed} passed, ${failed} failed ---`);
if (failed > 0) process.exit(1);
process.exit(0);
ailed ---`);
if (failed > 0) process.exit(1);
process.exit(0);
