// QA regression suite for the 8 confirmed Families-tab bugs from
// families_debug_report.md (May 2026). Plus a sanity check on the
// CurrentNeedsCard re-entrancy guard (likely #11) and the family-AI
// distribution-history wiring.
//
// Run with: node scripts/qa/test-families-fixes.mjs

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..', '..');
const read = (p) => readFileSync(resolve(root, p), 'utf8');

let passed = 0;
let failed = 0;
const fail = (msg) => { console.log(`FAIL: ${msg}`); failed++; };
const ok = (msg) => { console.log(`PASS: ${msg}`); passed++; };
const expect = (cond, msg) => (cond ? ok(msg) : fail(msg));

console.log('--- Bug #1: FamilyDetail back-link & not-found are localized ---');
{
  const src = read('src/pages/FamilyDetail.tsx');
  expect(!/<ArrowLeft[^/]*\/>\s*Families\b/.test(src), 'No literal " Families" after ArrowLeft icon');
  expect(/t\('families\.title'\)/.test(src), "Back link uses t('families.title')");
  expect(!/<EmptyState[^>]*title="Family not found"/.test(src), 'No literal "Family not found" string');
  expect(/t\('family_detail\.not_found'\)/.test(src), "EmptyState title uses t('family_detail.not_found')");
}

console.log('--- Bug #2 + #3: displacement and income dropdowns localized ---');
{
  const src = read('src/components/FamilyEditModal.tsx');
  expect(/t\(`families_edit\.displacement_\$\{opt\}`\)/.test(src), 'Displacement option uses t() template');
  expect(/t\(`families_edit\.income_\$\{opt\}`\)/.test(src), 'Income option uses t() template');
}

console.log('--- Bug #4: Families card medical count is localized ---');
{
  const src = read('src/pages/Families.tsx');
  expect(!/\{family\.medical_conditions\.length\} medical\b/.test(src), 'No literal "medical" suffix');
  expect(/t\('families\.medical_count',\s*\{[\s\S]*count:/.test(src), "Uses t('families.medical_count', { count }) plural");
}

console.log('--- Bug #5: FamilyEditModal calls newFamilyId() at most once ---');
{
  const src = read('src/components/FamilyEditModal.tsx');
  const handleSection = src.slice(src.indexOf('const handleSave'), src.indexOf('// Recompute the rule-based priority'));
  const calls = (handleSection.match(/newFamilyId\(\)/g) ?? []).length;
  expect(calls === 1, `newFamilyId() called exactly once in handleSave (got ${calls})`);
  expect(/const\s+family_id\s*=\s*existing\?\.family_id\s*\?\?\s*newFamilyId\(\);/.test(handleSection), 'family_id computed once into a const');
}

console.log('--- Bug #6: Families search trims whitespace ---');
{
  const src = read('src/pages/Families.tsx');
  expect(/const\s+q\s*=\s*search\.trim\(\)\.toLowerCase\(\);/.test(src), 'Search hoists `q = search.trim().toLowerCase()`');
}

console.log('--- Bug #7: AI system prompt uses `recommended` (rule-engine fallback) ---');
{
  const src = read('src/pages/FamilyDetail.tsx');
  const prompt = src.match(/CURRENT NEED ITEMS[\s\S]*?==========/);
  expect(prompt !== null, 'Found the CURRENT NEED ITEMS prompt block');
  if (prompt) {
    expect(/recommended\.length\s*>\s*0/.test(prompt[0]), 'systemPrompt checks `recommended.length > 0`');
    expect(/recommended\s*\.map/.test(prompt[0]), 'systemPrompt iterates `recommended` (with rule-engine fallback)');
  }
}

console.log('--- Bug #8: CurrentNeedsCard maps more IDB error names ---');
{
  const src = read('src/pages/FamilyDetail.tsx');
  expect(/Constraint/i.test(src), 'Constraint / DataError mapped');
  expect(/NotAllowed\|Security/i.test(src), 'NotAllowed / Security errors mapped');
  expect(/Timeout\|Transaction/i.test(src), 'Timeout / Transaction errors mapped');
  expect(/VersionError/i.test(src), 'VersionError mapped');
}

console.log('--- Likely #11: CurrentNeedsCard busyRef re-entrancy guard ---');
{
  const src = read('src/pages/FamilyDetail.tsx');
  expect(/useRef/.test(src), 'useRef is imported');
  expect(/busyRef\s*=\s*useRef\(false\)/.test(src), 'busyRef = useRef(false) declared');
  expect(/if\s*\(busyRef\.current\)\s*return/.test(src), 'save() drops duplicate calls');
  expect(/busyRef\.current\s*=\s*true/.test(src) && /busyRef\.current\s*=\s*false/.test(src), 'busyRef toggled true/false');
}

console.log('--- AI gets distribution history in family-scoped chat ---');
{
  const aiChat = read('src/components/AIChat.tsx');
  expect(/import\s+type\s+\{[^}]*AidDistribution/.test(aiChat), 'AIChat imports AidDistribution');
  expect(/history\?:\s*AidDistribution\[\]/.test(aiChat), 'AIChatProps declares history?: AidDistribution[]');
  expect(/function\s+buildInlineContext\([^)]*history:\s*AidDistribution\[\]/.test(aiChat), 'buildInlineContext accepts history param');
  expect(/function\s+summarizeDistribution\(/.test(aiChat), 'summarizeDistribution helper exists');
  expect(/recent_distributions/.test(aiChat), 'Inline context emits recent_distributions section');
  expect(/db\.distributions[\s\S]{0,80}where\(['"]family_id['"]\)/.test(aiChat), 'send() re-fetches latest distribution rows');
  expect(/buildInlineContext\(freshFamily,\s*freshHistory\)/.test(aiChat), 'send() passes freshHistory into buildInlineContext');
  const familyDetail = read('src/pages/FamilyDetail.tsx');
  expect(/<AIChat[\s\S]*?history=\{history\}/.test(familyDetail), 'FamilyDetail passes history={history}');
  expect(/DISTRIBUTION HISTORY/.test(familyDetail), 'systemPrompt mentions DISTRIBUTION HISTORY');
}

console.log('--- Locale parity: all new families keys present in en/ar/fr/es ---');
{
  const requiredKeys = [
    'families.medical_count_one',
    'families.medical_count_other',
    'family_detail.not_found',
    'families_edit.displacement_resident',
    'families_edit.displacement_recently_displaced',
    'families_edit.displacement_refugee',
    'families_edit.income_none',
    'families_edit.income_minimal',
    'families_edit.income_moderate',
  ];
  for (const lang of ['en', 'ar', 'fr', 'es']) {
    const obj = JSON.parse(read(`src/locales/${lang}.json`));
    const get = (path) => path.split('.').reduce((o, k) => (o && k in o ? o[k] : undefined), obj);
    for (const key of requiredKeys) {
      const val = get(key);
      expect(typeof val === 'string' && val.length > 0, `${lang}.json has non-empty ${key}`);
      if (lang !== 'en' && typeof val === 'string') {
        const en = JSON.parse(read('src/locales/en.json'));
        const enVal = key.split('.').reduce((o, k) => (o && k in o ? o[k] : undefined), en);
        if (typeof enVal === 'string' && enVal.length > 4 && val === enVal) {
          fail(`${lang}.json:${key} still equals EN ("${enVal}") — likely untranslated`);
        }
      }
    }
  }
}

console.log('========================');
console.log(`PASSED: ${passed}`);
console.log(`FAILED: ${failed}`);
process.exit(failed === 0 ? 0 : 1);
