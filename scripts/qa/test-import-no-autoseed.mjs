// QA regression — imports MUST NOT auto-invent `recommended_items`.
//
// Bug being fixed (reported 2026-05-12):
//   When a family is created through the spreadsheet wizard or the
//   photo ingest path, the resulting Family row had `recommended_items`
//   populated even though neither the source spreadsheet nor the source
//   photo ever mentioned items. The auto-population came from the rule
//   engine inside the commit path (`computeRuleScore` returns a sensible
//   default item list based on demographics — e.g. children<5 →
//   "infant formula"). That output is a *hint*, not a fact; persisting
//   it pretends the source had data it didn't.
//
// The fix:
//   - src/services/formIngest.ts: commitFamilyCandidate no longer
//     copies `scored.recommended_items` onto the Family row.
//   - src/components/FamilyEditModal.tsx: the save handler no longer
//     seeds `family.recommended_items` from the rule engine. Existing
//     rows still preserve their items via the `...existing` spread.
//
// What this test verifies (static / source-grep — no browser, no Dexie):
//
//   1. formIngest.commitFamilyCandidate never writes recommended_items
//      from the rule engine.
//   2. The FamilyCandidate type still has no recommended_items field
//      (so photos can't accidentally smuggle them in).
//   3. FamilyEditModal's save handler does not assign
//      family.recommended_items from `r.recommended_items`.
//   4. FamilyEditModal still preserves an existing family's items
//      through the `...existing` spread (no regression for edits).
//   5. The UI fallback that surfaces rule-engine suggestions when
//      recommended_items is unset still exists in FamilyRow and
//      CurrentNeedsCard (so helpful HINTS keep showing, they just
//      aren't stamped onto the DB row).
//   6. The spreadsheet importer (spreadsheetImport.ts) doesn't
//      reference recommended_items at all — so a CSV/XLSX row can
//      never accidentally smuggle items in either.
//
// Run with: node scripts/qa/test-import-no-autoseed.mjs

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

// =============================================================
console.log('--- Test 1: photo ingest never copies items from rule engine ---');
{
  const src = read('src/services/formIngest.ts');

  // The previous buggy line copied scored.recommended_items onto the
  // family row. It MUST be gone.
  expect(
    !/family\.recommended_items\s*=\s*scored\.recommended_items/.test(src),
    'commitFamilyCandidate does NOT assign scored.recommended_items to family',
  );

  // It must still compute the score (we only stripped items, not score).
  expect(
    /const scored = computeRuleScore\(family\);/.test(src),
    'commitFamilyCandidate still computes the priority score',
  );
  expect(
    /family\.priority_score = scored\.priority_score;/.test(src),
    'commitFamilyCandidate still sets priority_score',
  );
  expect(
    /family\.priority_level = scored\.priority_level;/.test(src),
    'commitFamilyCandidate still sets priority_level',
  );
  expect(
    /family\.ai_reason = scored\.reason;/.test(src),
    'commitFamilyCandidate still sets ai_reason',
  );

  // Make sure nothing ELSE inside commitFamilyCandidate sneaks items in.
  // Look for any `recommended_items =` assignment in the file.
  const recAssignments = [...src.matchAll(/recommended_items\s*=/g)];
  expect(
    recAssignments.length === 0,
    'no recommended_items assignment anywhere in formIngest.ts',
  );
}

// =============================================================
console.log('\n--- Test 2: FamilyCandidate type has no recommended_items ---');
{
  const src = read('src/services/formIngest.ts');
  // Find the exported FamilyCandidate interface block (until the next
  // top-level `export` or end-of-file).
  const m = src.match(
    /export interface FamilyCandidate\s*\{([\s\S]*?)\n\}/,
  );
  expect(m !== null, 'FamilyCandidate interface block locatable');
  if (m) {
    const body = m[1];
    expect(
      !/recommended_items/.test(body),
      'FamilyCandidate has no recommended_items field — photos can\'t smuggle items',
    );
    // Sanity checks that the other expected fields are still there so
    // we know we matched the right interface.
    for (const f of [
      'head_name',
      'member_count',
      'medical_conditions',
      'notes',
    ]) {
      expect(
        new RegExp(`\\b${f}\\b`).test(body),
        `FamilyCandidate.${f} field present`,
      );
    }
  }
}

// =============================================================
console.log(
  '\n--- Test 3: FamilyEditModal save no longer auto-seeds items ---',
);
{
  const src = read('src/components/FamilyEditModal.tsx');

  // The previous code had this exact shape:
  //   if (!family.recommended_items?.length) {
  //     family.recommended_items = r.recommended_items;
  //   }
  // BOTH halves must be gone.
  expect(
    !/family\.recommended_items\s*=\s*r\.recommended_items/.test(src),
    'no `family.recommended_items = r.recommended_items` assignment',
  );
  expect(
    !/if\s*\(\s*!family\.recommended_items\?\.length\s*\)/.test(src),
    'the auto-seed guard `if (!family.recommended_items?.length)` is gone',
  );

  // The save handler MUST still compute the score (priority is not
  // affected by this bug).
  expect(
    /const r = computeRuleScore\(family\);/.test(src),
    'save handler still calls computeRuleScore',
  );
  expect(
    /family\.priority_score = r\.priority_score;/.test(src),
    'save handler still sets priority_score',
  );

  // Preservation-on-edit is handled implicitly by the `...existing`
  // spread when building the family object. Confirm that spread exists.
  expect(
    /\.\.\.\(existing \?\? \{ family_id \}\)/.test(src),
    'family object still spreads `existing` so edits preserve recommended_items',
  );
}

// =============================================================
console.log('\n--- Test 4: UI no longer falls back to rule-engine items ---');
{
  // The old fallback in FamilyRow looked like:
  //   const items = family.recommended_items !== undefined
  //     ? family.recommended_items
  //     : result?.recommended_items ?? [];
  // It MUST be gone — imports leave recommended_items undefined and we
  // want the card to show nothing rather than auto-invented hints.
  const list = read('src/pages/Families.tsx');
  expect(
    !/result\?\.recommended_items/.test(list),
    'Families list no longer references result.recommended_items',
  );
  expect(
    /const items = family\.recommended_items \?\? \[\];/.test(list),
    'Families list reads items only from the family row, defaulting to []',
  );

  // FamilyDetail used to pass fallbackItems into CurrentNeedsCard. Both
  // the call site and the prop must be gone.
  const detail = read('src/pages/FamilyDetail.tsx');
  expect(
    !/fallbackItems/.test(detail),
    'FamilyDetail no longer mentions fallbackItems anywhere',
  );
  expect(
    /<CurrentNeedsCard family=\{family\} \/>/.test(detail),
    'CurrentNeedsCard is invoked with ONLY the family prop',
  );
  expect(
    /family\.recommended_items \?\? \[\]/.test(detail),
    'FamilyDetail derives items from family row with [] default',
  );
}

// =============================================================
console.log(
  '\n--- Test 4b: seeded demo families ship with explicit items ---',
);
{
  // After removing the UI fallback, the only way seeded demo families
  // get items is via an explicit seed-time pass through the rule
  // engine. Verify that pass exists.
  const seed = read('src/db/seedData.ts');
  expect(
    /import \{ computeRuleScore \} from '@\/services\/priorityRules';/.test(
      seed,
    ),
    'seedData imports computeRuleScore for the seed-time pass',
  );
  expect(
    /const seededFamilies: Family\[\] = families\.map\(\(f\) => \{/.test(seed),
    'seeded families pass through a per-family map before bulkAdd',
  );
  expect(
    /recommended_items: r\.recommended_items/.test(seed),
    'each seeded family gets r.recommended_items stamped in',
  );
  expect(
    /db\.families\.bulkAdd\(seededFamilies\)/.test(seed),
    'seed transaction inserts the stamped seededFamilies, not the raw array',
  );
}

// =============================================================
console.log('\n--- Test 5: spreadsheet importer ignores items entirely ---');
{
  const src = read('src/services/spreadsheetImport.ts');
  // The importer never touches recommended_items. If someone adds an
  // "Items" column to a CSV it currently lands in Notes (per README).
  // We want to be sure we haven't accidentally introduced an auto-seed
  // here while fixing the other paths.
  expect(
    !/recommended_items/.test(src),
    'spreadsheetImport.ts never references recommended_items',
  );
}

// =============================================================
console.log('\n--- Test 6: rule engine still produces items (sanity) ---');
{
  // The rule engine output isn't the bug — it's a useful hint surface.
  // Just sanity-check it still RETURNS recommended_items so the UI
  // fallback has something to show.
  const src = read('src/services/priorityRules.ts');
  expect(
    /recommended_items/.test(src),
    'priorityRules.ts still computes recommended_items (used as UI hints)',
  );
}

// =============================================================
console.log(
  `\n========= ${passed} PASS / ${failed} FAIL =========`,
);
process.exit(failed === 0 ? 0 : 1);
