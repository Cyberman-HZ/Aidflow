// QA regression suite for the family soft-delete + reason-required flow.
//
// What's exercised (static / pure-function tests; no browser, no Dexie):
//
//   1. Type contract — `Family.deletion_reason?: string` exists alongside
//      `Family.deleted_at?: string` so the soft-delete write has a place
//      to land the reason.
//   2. Validator — the exported MIN_REASON_LENGTH constant and the
//      isReasonValid() helper agree on the same rule: trimmed length
//      >= 4 chars. We re-implement the predicate locally and assert
//      parity at the boundary cases.
//   3. Wiring — Families.tsx imports DeleteFamilyModal and renders it
//      under {deleteTarget && ...}, AND writes BOTH deleted_at and
//      deletion_reason on confirm.
//   4. Trash button — the row renders a Trash2 button with the correct
//      a11y label, NOT a window.confirm() call (per the requirement
//      that the popup must be in-app).
//   5. Locale parity — the new `families_delete.*` keys exist in all
//      four locales (en / ar / fr / es) and share the same key set.
//   6. Soft-delete-preserves-history invariant — the live-query that
//      hides deleted families MUST still filter on `!f.deleted_at`.
//      We grep for that exact pattern.
//   7. No native confirm/prompt anywhere in the new code path.
//
// Run with: node scripts/qa/test-family-delete.mjs

import { readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..', '..');
const read = (p) => readFileSync(resolve(root, p), 'utf8');
const exists = (p) => {
  try {
    return statSync(resolve(root, p)).isFile();
  } catch {
    return false;
  }
};

let passed = 0;
let failed = 0;
const ok = (msg) => {
  console.log(`PASS: ${msg}`);
  passed++;
};
const fail = (msg) => {
  console.log(`FAIL: ${msg}`);
  failed++;
};
const expect = (cond, msg) => (cond ? ok(msg) : fail(msg));

// =============================================================
console.log('--- Test 1: type contract ---');
{
  const t = read('src/types/index.ts');
  expect(
    /deleted_at\?:\s*string;/.test(t),
    'Family.deleted_at?: string is declared',
  );
  expect(
    /deletion_reason\?:\s*string;/.test(t),
    'Family.deletion_reason?: string is declared',
  );
  // The reason field must be optional (the column can be empty on
  // pre-existing rows) but always set when deleted_at is set.
  expect(
    /Free-text reason captured at delete time/.test(t),
    'deletion_reason has a justifying jsdoc comment',
  );
}

// =============================================================
console.log('\n--- Test 2: isReasonValid behaviour ---');
{
  // Re-implementation that MUST match the exported helper.
  const MIN = 4;
  const isReasonValid = (r) => r.trim().length >= MIN;

  expect(isReasonValid('relocated') === true, '"relocated" is valid');
  expect(
    isReasonValid('   duplicate   ') === true,
    'leading/trailing whitespace trimmed',
  );
  expect(isReasonValid('') === false, 'empty string rejected');
  expect(isReasonValid('   ') === false, 'whitespace-only rejected');
  expect(isReasonValid('abc') === false, '3 chars rejected (below min)');
  expect(isReasonValid('abcd') === true, '4 chars accepted (at min)');
  // String.prototype.trim() removes ONLY leading/trailing whitespace,
  // so internal newlines stay in the length count.
  expect(
    isReasonValid('a\nb\nc') === true,
    'internal newlines kept by trim() — 5-char string is valid',
  );
  expect(
    isReasonValid('\n\nab') === false,
    'leading newlines + 2 chars trimmed to 2 — rejected',
  );

  // Confirm the modal source declares the same constant and helper.
  const modal = read('src/components/DeleteFamilyModal.tsx');
  expect(
    /export const MIN_REASON_LENGTH = 4;/.test(modal),
    'MIN_REASON_LENGTH = 4 exported from modal',
  );
  expect(
    /export function isReasonValid\(reason: string\): boolean/.test(modal),
    'isReasonValid exported for downstream test imports',
  );
  expect(
    /return reason\.trim\(\)\.length >= MIN_REASON_LENGTH;/.test(modal),
    'isReasonValid trims and compares against the constant',
  );
}

// =============================================================
console.log('\n--- Test 3: Families.tsx wiring ---');
{
  const fam = read('src/pages/Families.tsx');
  expect(
    /import DeleteFamilyModal from '@\/components\/DeleteFamilyModal'/.test(fam),
    'DeleteFamilyModal is imported',
  );
  expect(/Trash2/.test(fam), 'Trash2 icon is imported');
  expect(
    /const \[deleteTarget, setDeleteTarget\] = useState<Family \| null>\(null\);/.test(
      fam,
    ),
    'deleteTarget state is declared as Family | null',
  );
  expect(
    /\{deleteTarget && \(\s*<DeleteFamilyModal/.test(fam),
    'modal rendered conditionally on deleteTarget',
  );
  // The write must include BOTH fields.
  expect(
    /db\.families\.update\([\s\S]*?deleted_at: new Date\(\)\.toISOString\(\)[\s\S]*?deletion_reason: reason/.test(
      fam,
    ),
    'soft-delete writes BOTH deleted_at and deletion_reason in one update',
  );
  // Reason must come from the modal callback (not be hard-coded).
  expect(
    /onConfirm=\{async \(reason\) => \{/.test(fam),
    'onConfirm receives the reason from the modal',
  );
}

// =============================================================
console.log('\n--- Test 4: Trash button is in-app (no native confirm) ---');
{
  const fam = read('src/pages/Families.tsx');
  // Must NOT use window.confirm / window.prompt for the delete flow.
  expect(
    !/window\.confirm\s*\(/.test(fam),
    'Families.tsx does not use window.confirm',
  );
  expect(
    !/window\.prompt\s*\(/.test(fam),
    'Families.tsx does not use window.prompt',
  );
  // Same check on the modal.
  const modal = read('src/components/DeleteFamilyModal.tsx');
  expect(
    !/window\.confirm\s*\(|window\.prompt\s*\(/.test(modal),
    'DeleteFamilyModal does not use native confirm/prompt',
  );
  // Trash button must call onDelete via an in-component callback.
  expect(
    /<Trash2 size=\{16\} \/>/.test(fam),
    'Trash2 icon rendered in FamilyRow',
  );
  expect(
    /aria-label=\{t\('families_delete\.button_label'/.test(fam),
    'Trash button has an i18n aria-label',
  );
}

// =============================================================
console.log('\n--- Test 5: locale parity (en/ar/fr/es) ---');
{
  const requiredKeys = [
    'button_label',
    'button_tooltip',
    'title',
    'body',
    'reason_label',
    'reason_placeholder',
    'reason_hint',
    'reason_too_short',
    'delete',
    'failed',
  ];
  for (const lang of ['en', 'ar', 'fr', 'es']) {
    const path = `src/locales/${lang}.json`;
    expect(exists(path), `${lang}.json exists`);
    let json;
    try {
      json = JSON.parse(read(path));
    } catch (e) {
      fail(`${lang}.json parses as JSON: ${e.message}`);
      continue;
    }
    const block = json.families_delete;
    expect(
      block && typeof block === 'object',
      `${lang}.families_delete block present`,
    );
    if (!block) continue;
    for (const k of requiredKeys) {
      expect(
        typeof block[k] === 'string' && block[k].length > 0,
        `${lang}.families_delete.${k} is a non-empty string`,
      );
    }
    // Placeholders the React component needs interpolated.
    expect(
      block.button_label.includes('{{name}}'),
      `${lang}.families_delete.button_label uses {{name}}`,
    );
    expect(
      block.body.includes('{{name}}'),
      `${lang}.families_delete.body uses {{name}}`,
    );
    expect(
      block.reason_hint.includes('{{min}}'),
      `${lang}.families_delete.reason_hint uses {{min}}`,
    );
  }
}

// =============================================================
console.log(
  '\n--- Test 6: soft-delete-preserves-history invariant ---',
);
{
  const fam = read('src/pages/Families.tsx');
  // The live query that drives the visible list MUST filter on
  // !f.deleted_at, otherwise the just-deleted family would still be
  // shown.
  expect(
    /\.filter\(\(f\) => !f\.deleted_at\)/.test(fam),
    'Families.tsx live query still filters out deleted_at rows',
  );
  // Distribution history references must NOT be filtered (the whole
  // point of soft-delete is that historic rows resolve the family).
  // We assert this indirectly: the deletion handler does NOT touch the
  // distributions table.
  expect(
    !/db\.distributions\.delete|db\.distributions\.where\([^)]*\)\.delete/.test(
      fam,
    ),
    'soft-delete does not remove any distributions',
  );
}

// =============================================================
console.log('\n--- Test 7: typescript-clean exports from the modal ---');
{
  const modal = read('src/components/DeleteFamilyModal.tsx');
  // Default export of the modal component.
  expect(
    /export default function DeleteFamilyModal\(/.test(modal),
    'DeleteFamilyModal is the default export',
  );
  // Required-reason behaviour wired through state.
  expect(
    /const \[reason, setReason\] = useState\(''\);/.test(modal),
    'reason state seeded as empty string',
  );
  // Delete button must be disabled until the reason is valid.
  expect(
    /disabled=\{!canDelete\}/.test(modal),
    'Delete button is disabled when canDelete is false',
  );
  // Backdrop click cancels (unless mid-delete).
  expect(
    /if \(!deleting\) onCancel\(\);/.test(modal),
    'backdrop click cancels only when not mid-delete',
  );
  // Esc cancels (unless mid-delete).
  expect(
    /e\.key === 'Escape' && !deleting/.test(modal),
    'Escape cancels only when not mid-delete',
  );
}

// =============================================================
console.log('\n--- Test 8: Dashboard surfaces deletions ---');
{
  const dash = read('src/pages/Dashboard.tsx');

  // (a) Dedicated live query for deleted families, sorted newest-first.
  expect(
    /const deletedFamilies =[\s\S]*useLiveQuery/.test(dash),
    'Dashboard has a deletedFamilies live query',
  );
  expect(
    /\.filter\(\(f\) => !!f\.deleted_at\)/.test(dash),
    'deletedFamilies query keeps only rows WITH deleted_at',
  );
  expect(
    /localeCompare\(a\.deleted_at \?\? ''\)/.test(dash),
    'deletedFamilies sorted newest-first by deleted_at',
  );

  // (b) "Recent family deletions" Card renders name + family_id + reason.
  expect(
    /t\('dashboard\.recent_deletions'\)/.test(dash),
    'Dashboard renders the recent-deletions card title via i18n',
  );
  expect(
    /\{f\.head_name\}[\s\S]*?\{f\.family_id\}/.test(dash),
    'card shows both head_name and family_id',
  );
  expect(
    /\{f\.deletion_reason \|\|/.test(dash),
    'card shows deletion_reason with fallback for empty reason',
  );
  expect(
    /t\('dashboard\.deletion_reason'\)/.test(dash),
    'card labels the reason field via i18n',
  );
  expect(
    /deletedFamilies\.slice\(0, 10\)/.test(dash),
    'card displays at most 10 most-recent deletions',
  );
  expect(
    /t\('dashboard\.deletions_more'/.test(dash),
    'card shows overflow count when more than 10 exist',
  );

  // (c) AI summary payload carries deletions to the model.
  expect(
    /families_deleted_total: deletedFamilies\.length/.test(dash),
    'AI payload exposes families_deleted_total',
  );
  expect(
    /recent_family_deletions: recentDeletions/.test(dash),
    'AI payload exposes recent_family_deletions',
  );

  // (d) System prompt instructs the model to produce a Registry deletions
  //     section that contains name + ID + reason for each row.
  expect(
    /## Registry deletions/.test(dash),
    'AI system prompt names the Registry deletions section',
  );
  expect(
    /EACH BULLET MUST INCLUDE/.test(dash) &&
      /head_name/.test(dash) &&
      /family_id/.test(dash) &&
      /reason/.test(dash),
    'AI prompt requires name + family_id + reason on every deletion bullet',
  );
  expect(
    /No families have been deleted from the registry/.test(dash),
    'AI prompt has an explicit empty-list fallback',
  );

  // (e) Rule-based offline fallback ALSO emits the same section so the
  //     report works without Ollama.
  expect(
    /## Registry deletions/.test(dash) &&
      /payload\.recent_family_deletions\.length > 0/.test(dash),
    'rule-based summary emits a Registry deletions section when deletions exist',
  );
  expect(
    /Reason: \$\{d\.reason\}/.test(dash),
    'rule-based bullet includes the verbatim reason',
  );
  expect(
    /\*\*\$\{d\.head_name\}\*\* \(\$\{d\.family_id\}, \$\{d\.sector\}\)/.test(dash),
    'rule-based bullet includes name + family_id + sector',
  );
}

// =============================================================
console.log('\n--- Test 9: Dashboard locale parity for the new keys ---');
{
  const requiredKeys = [
    'recent_deletions',
    'deletion_reason',
    'deletion_reason_missing',
    'deleted_at',
    'deletions_more',
  ];
  for (const lang of ['en', 'ar', 'fr', 'es']) {
    const json = JSON.parse(read(`src/locales/${lang}.json`));
    const block = json.dashboard;
    expect(
      block && typeof block === 'object',
      `${lang}.dashboard block present`,
    );
    if (!block) continue;
    for (const k of requiredKeys) {
      expect(
        typeof block[k] === 'string' && block[k].length > 0,
        `${lang}.dashboard.${k} is a non-empty string`,
      );
    }
    // The overflow string must keep its {{count}} interpolation.
    expect(
      block.deletions_more.includes('{{count}}'),
      `${lang}.dashboard.deletions_more keeps the {{count}} interpolation`,
    );
  }
}

// =============================================================
console.log(
  `\n========= ${passed} PASS / ${failed} FAIL =========`,
);
process.exit(failed === 0 ? 0 : 1);
