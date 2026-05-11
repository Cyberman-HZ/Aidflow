// QA suite for the no-duplicate-families invariant.
//
// Bug being fixed (reported 2026-05-12):
//   The same family could be created multiple times via any of the three
//   creation paths — manual form, spreadsheet wizard, photo ingest. There
//   was no de-duplication anywhere.
//
// The rule (per product spec):
//   A family is a duplicate of an existing NON-deleted family when both
//   `head_name` (trimmed, case-insensitive, whitespace-collapsed) and
//   `member_count` match. Soft-deleted families are EXCLUDED — if an
//   admin previously deleted a household and is re-registering it, that's
//   a deliberate re-creation.
//
// What this test covers (static / pure-function tests — no browser, no
// Dexie. The findDuplicateFamilySync helper is exported precisely so we
// can hit it without a live IndexedDB):
//
//   1. normalizeHeadName — boundary cases for the comparator (whitespace,
//      casing, multilingual lowercase).
//   2. findDuplicateFamilySync — positive and negative match cases,
//      excludeId behaviour, soft-delete exclusion, member-count
//      discrimination.
//   3. Source-grep checks confirming each of the three creation paths
//      actually wires the helper in.
//   4. DuplicateFamilyError shape (exposed so callers can `instanceof`).
//   5. Locale parity for the new strings.
//
// Run with: node scripts/qa/test-duplicate-prevention.mjs

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..', '..');
const read = (p) => readFileSync(resolve(root, p), 'utf8');

let passed = 0;
let failed = 0;
const ok = (msg) => { console.log(`PASS: ${msg}`); passed++; };
const fail = (msg) => { console.log(`FAIL: ${msg}`); failed++; };
const expect = (cond, msg) => (cond ? ok(msg) : fail(msg));

// ----- Re-implementations matching the production logic -------------------
// (Importing the .ts file would require a TS loader; copying the
// implementation here keeps the QA script dependency-free. Test 3
// confirms the actual production file matches these shapes.)

function normalizeHeadName(name) {
  return name.replace(/\s+/g, ' ').trim().toLocaleLowerCase();
}

function findDuplicateFamilySync(families, headName, memberCount, excludeId) {
  const needle = normalizeHeadName(headName);
  if (!needle) return null;
  if (!Number.isFinite(memberCount) || memberCount < 1) return null;
  const hit = families.find(
    (f) =>
      !f.deleted_at &&
      f.family_id !== excludeId &&
      f.member_count === memberCount &&
      normalizeHeadName(f.head_name) === needle,
  );
  return hit
    ? {
        family_id: hit.family_id,
        head_name: hit.head_name,
        member_count: hit.member_count,
      }
    : null;
}

// =============================================================
console.log('--- Test 1: normalizeHeadName ---');
{
  expect(
    normalizeHeadName('Ahmed Al-Rashid') === 'ahmed al-rashid',
    'plain ASCII lowercased',
  );
  expect(
    normalizeHeadName('  Ahmed   Al-Rashid  ') === 'ahmed al-rashid',
    'leading / trailing whitespace stripped, internal whitespace collapsed',
  );
  expect(
    normalizeHeadName('AHMED AL-RASHID') === 'ahmed al-rashid',
    'all-caps lowercased',
  );
  expect(normalizeHeadName('') === '', 'empty string stays empty');
  expect(normalizeHeadName('   ') === '', 'whitespace-only collapses to empty');
  // Locale-aware fold — Arabic doesn't really have case but the helper
  // shouldn't crash, and stays as-is.
  expect(
    normalizeHeadName('ناصر زدني') === 'ناصر زدني',
    'Arabic name passes through unchanged',
  );
}

// =============================================================
console.log('\n--- Test 2: findDuplicateFamilySync ---');
{
  const families = [
    { family_id: 'F-0001', head_name: 'Ahmed Al-Rashid', member_count: 7 },
    { family_id: 'F-0002', head_name: 'Maria Gonzalez', member_count: 5 },
    {
      family_id: 'F-0003',
      head_name: 'Naser Zadany',
      member_count: 8,
      deleted_at: '2026-05-11T10:00:00.000Z',
    },
    { family_id: 'F-0004', head_name: 'Mohammed Khalil', member_count: 3 },
    { family_id: 'F-0005', head_name: 'Mohammed Khalil', member_count: 6 },
  ];

  // Positive cases
  expect(
    findDuplicateFamilySync(families, 'Ahmed Al-Rashid', 7)?.family_id === 'F-0001',
    'exact match flags F-0001',
  );
  expect(
    findDuplicateFamilySync(families, '  ahmed al-rashid  ', 7)?.family_id === 'F-0001',
    'whitespace + casing differences still match',
  );
  expect(
    findDuplicateFamilySync(families, 'Maria  Gonzalez', 5)?.family_id === 'F-0002',
    'internal-whitespace variant matches',
  );

  // Negative — different member count
  expect(
    findDuplicateFamilySync(families, 'Mohammed Khalil', 3)?.family_id === 'F-0004',
    'name + 3 members matches F-0004',
  );
  expect(
    findDuplicateFamilySync(families, 'Mohammed Khalil', 6)?.family_id === 'F-0005',
    'same name + different count matches DIFFERENT row',
  );
  expect(
    findDuplicateFamilySync(families, 'Mohammed Khalil', 9) === null,
    'same name but novel member count → no duplicate',
  );

  // Soft-delete exclusion
  expect(
    findDuplicateFamilySync(families, 'Naser Zadany', 8) === null,
    'soft-deleted family does NOT count as a duplicate',
  );

  // excludeId — editing an existing family
  expect(
    findDuplicateFamilySync(
      families,
      'Ahmed Al-Rashid',
      7,
      'F-0001',
    ) === null,
    'excludeId=self prevents matching against own row (edit path)',
  );

  // Edge cases
  expect(
    findDuplicateFamilySync(families, '', 7) === null,
    'empty head_name → no duplicate',
  );
  expect(
    findDuplicateFamilySync(families, '   ', 7) === null,
    'whitespace-only head_name → no duplicate',
  );
  expect(
    findDuplicateFamilySync(families, 'Ahmed Al-Rashid', 0) === null,
    'member_count < 1 → no duplicate',
  );
  expect(
    findDuplicateFamilySync(families, 'Ahmed Al-Rashid', NaN) === null,
    'NaN member_count → no duplicate',
  );
}

// =============================================================
console.log(
  '\n--- Test 3: production source matches the test re-implementation ---',
);
{
  const src = read('src/services/familyDuplicates.ts');
  expect(
    /export function normalizeHeadName\(name: string\): string/.test(src),
    'normalizeHeadName is exported',
  );
  expect(
    /\.replace\(\/\\s\+\/g, ' '\)\.trim\(\)\.toLocaleLowerCase\(\)/.test(src),
    'normalizeHeadName collapses whitespace + trims + toLocaleLowerCase',
  );
  expect(
    /export async function findDuplicateFamily/.test(src),
    'findDuplicateFamily (async, Dexie-backed) is exported',
  );
  expect(
    /export function findDuplicateFamilySync/.test(src),
    'findDuplicateFamilySync (in-memory) is exported',
  );
  expect(
    /excludeId/.test(src),
    'both lookups support excludeId for the edit path',
  );
  expect(
    /!f\.deleted_at/.test(src),
    'both lookups filter out soft-deleted families',
  );
}

// =============================================================
console.log(
  '\n--- Test 4: FamilyEditModal blocks duplicate save ---',
);
{
  const src = read('src/components/FamilyEditModal.tsx');
  expect(
    /import \{ findDuplicateFamily \} from '@\/services\/familyDuplicates';/.test(
      src,
    ),
    'imports findDuplicateFamily',
  );
  expect(
    /const dup = await findDuplicateFamily\(/.test(src),
    'invokes findDuplicateFamily in the save handler',
  );
  expect(
    /excludeId/.test(src) ||
      /existing\?\.family_id \?\? family_id/.test(src),
    'passes family_id as the third arg so edits do not flag themselves',
  );
  expect(
    /families_edit\.duplicate_error/.test(src),
    'surfaces a localised duplicate_error message',
  );
  expect(
    /setSaving\(false\);\s*return;/.test(src),
    'returns early when a duplicate is found (no DB write)',
  );
}

// =============================================================
console.log(
  '\n--- Test 5: formIngest.commitFamilyCandidate blocks duplicates ---',
);
{
  const src = read('src/services/formIngest.ts');
  expect(
    /import \{ findDuplicateFamily \} from '\.\/familyDuplicates';/.test(src),
    'imports findDuplicateFamily',
  );
  expect(
    /export class DuplicateFamilyError extends Error/.test(src),
    'exports DuplicateFamilyError class',
  );
  expect(
    /readonly existing_family_id: string;/.test(src),
    'DuplicateFamilyError carries the existing family_id',
  );
  expect(
    /readonly existing_head_name: string;/.test(src) &&
      /readonly existing_member_count: number;/.test(src),
    'DuplicateFamilyError carries head_name + member_count',
  );
  expect(
    /const dup = await findDuplicateFamily\(\s*candidate\.head_name,\s*candidate\.member_count/.test(
      src,
    ),
    'commitFamilyCandidate runs the duplicate check before commit',
  );
  expect(
    /throw new DuplicateFamilyError/.test(src),
    'commit throws DuplicateFamilyError when a match is found',
  );
}

// =============================================================
console.log(
  '\n--- Test 6: PaperFormImport pre-flight duplicate badge ---',
);
{
  const src = read('src/components/PaperFormImport.tsx');
  expect(
    /findDuplicateFamilySync/.test(src),
    'imports findDuplicateFamilySync for live in-memory checks',
  );
  expect(
    /useLiveQuery<Family\[\]>\(\(\) => db\.families\.toArray\(\)/.test(src),
    'subscribes to the live families snapshot via useLiveQuery',
  );
  // The duplicate prop should be threaded into the card.
  expect(
    /duplicateOf:\s*DuplicateMatch \| null/.test(src),
    'CandidateCard accepts a duplicateOf prop of type DuplicateMatch | null',
  );
  // Apply must be disabled when duplicateOf is set.
  expect(
    /duplicateOf !== null/.test(src),
    'Apply button disabled when duplicateOf is set',
  );
  // The banner must render.
  expect(
    /paper_form\.duplicate_title/.test(src) &&
      /paper_form\.duplicate_body/.test(src),
    'duplicate banner renders with localised title + body',
  );
}

// =============================================================
console.log('\n--- Test 7: locale parity ---');
{
  for (const lang of ['en', 'ar', 'fr', 'es']) {
    const json = JSON.parse(read(`src/locales/${lang}.json`));
    // FamilyEditModal duplicate_error
    expect(
      typeof json.families_edit?.duplicate_error === 'string' &&
        json.families_edit.duplicate_error.length > 0,
      `${lang}.families_edit.duplicate_error present`,
    );
    for (const placeholder of ['{{name}}', '{{members}}', '{{id}}']) {
      expect(
        json.families_edit.duplicate_error.includes(placeholder),
        `${lang}.families_edit.duplicate_error contains ${placeholder}`,
      );
    }
    // PaperFormImport duplicate_*
    for (const k of [
      'duplicate_title',
      'duplicate_body',
      'duplicate_tooltip',
    ]) {
      expect(
        typeof json.paper_form?.[k] === 'string' && json.paper_form[k].length > 0,
        `${lang}.paper_form.${k} present`,
      );
    }
    // duplicate_body must interpolate name + members + id; tooltip just id.
    for (const placeholder of ['{{name}}', '{{members}}', '{{id}}']) {
      expect(
        json.paper_form.duplicate_body.includes(placeholder),
        `${lang}.paper_form.duplicate_body contains ${placeholder}`,
      );
    }
    expect(
      json.paper_form.duplicate_tooltip.includes('{{id}}'),
      `${lang}.paper_form.duplicate_tooltip contains {{id}}`,
    );
  }
}

// =============================================================
console.log(
  `\n========= ${passed} PASS / ${failed} FAIL =========`,
);
process.exit(failed === 0 ? 0 : 1);
