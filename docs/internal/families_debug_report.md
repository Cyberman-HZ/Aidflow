# Families Tab Debug Report

Generated 2026-05-09 from a read-only review of `src/pages/Families.tsx` (406 lines), `src/pages/FamilyDetail.tsx` (472 lines), `src/components/FamilyEditModal.tsx` (590 lines), `src/components/EditableDemographicsCard.tsx` (342 lines), `src/components/EditableMedicalCard.tsx` (261 lines), `src/components/AIChat.tsx` (742 lines), `src/services/priorityRules.ts` (219 lines), `src/services/familyIntent.ts` (218 lines), `src/types/index.ts`, `src/db/database.ts` (v8 migration), and `src/locales/{en,ar,fr,es}.json`.

## Pre-flight

- `npx tsc --noEmit` -> exit 0 (no TypeScript errors).
- `node scripts/qa/test-family-profile.mjs` -> PASSED 44 / FAILED 0.
- `node scripts/qa/test-family-profile-fixes.mjs` -> PASSED 30 / FAILED 0.
- Locale key parity for the older keys is reasonable in EN; AR/FR/ES coverage on the `families`/`families_edit`/`family_detail` blocks should be re-checked since several enum values bypass `t()` entirely (see findings #2–4).

## Reproduction summary

| User flow | Code path | Expected | Actual |
|---|---|---|---|
| List load | `Families.tsx:56-60` `useLiveQuery` -> `ruleResults` memoized, AI overrides on demand | Scores computed offline, distributions fetched for history | OK |
| Search | `Families.tsx:90-95` filters by `head_name` and `family_id` case-insensitive | Substring match on both fields, trimmed | OK on case; **does not `.trim()`** the query (gap) |
| Sector filter | `Families.tsx:46, 85` closed-set from families list | Dropdown reflects all sectors; exact match filter | OK |
| Priority filter | `Families.tsx:87-89` against `byId` map (AI or rule results) | Filters by computed `priority_level` | OK |
| Sort key | `Families.tsx:101-126` 8 sort modes, tiebreak on score | Stable sort, correct tie-break order | OK |
| Add family modal | `FamilyEditModal.tsx:74-225` -> `db.families.put` | Validate required fields, recompute priority, save | OK functionally; **double `newFamilyId()` call** (see #5) |
| Click family card | `Families.tsx:287` Link to `/families/{family_id}` -> `FamilyDetail.tsx` | Navigate and load family record | OK; missing-family handled with EmptyState (but **English-only**, see #1) |
| Inline demo edit | `EditableDemographicsCard.tsx` mode toggle + save | Validate invariant (children + elderly <= members), recompute priority | OK |
| Medical edit | `EditableMedicalCard.tsx` add/remove conditions, save | Severity tags fed to rule engine, priority recalculated | OK |
| Current needs card | `FamilyDetail.tsx:203-425` `CurrentNeedsCard` inline edit | Add/remove items with quantity, save to DB | OK; v8 migration ensures all items are `{name, quantity}` objects |
| Delete family | `FamilyEditModal.tsx:507-524` delete + confirm -> `db.families.delete` | Hard-delete (no cascading) | **Distributions orphaned** (see cross-feature concerns) |
| AI chat in family | `AIChat.tsx:182-400` intent short-circuit + fallback to Gemma 4 | Deterministic detector first, fallback to LLM | OK; family snapshot injected inline |

## Findings

### CONFIRMED bugs

1. **`FamilyDetail.tsx:60` and `:62` — hardcoded English strings.**
   Line 60: `<ArrowLeft size={14} /> Families` — the back-link text is a literal "Families" not `t('nav.families')`.
   Line 62: `<EmptyState title="Family not found" />` — title is hardcoded.
   Users in AR/FR/ES see English text when a family is deleted between list view and detail click. Recommended fix: `<ArrowLeft size={14} /> {t('nav.families')}` and `<EmptyState title={t('family_detail.not_found') ?? 'Family not found'} />`. Add `family_detail.not_found` to all four locale files.

2. **`FamilyEditModal.tsx:374-378` — displacement-status dropdown shows raw enum values.**
   Code: `<option key={opt} value={opt}>{opt.replace('_', ' ')}</option>` renders "resident", "recently displaced", "refugee" verbatim — never localised. Recommended fix: a `displacementLabel(opt, t)` helper that returns `t('families_edit.displacement_resident')` etc., with keys added to the locale files.

3. **`FamilyEditModal.tsx:385-393` — income-level dropdown shows raw enum values.**
   Same pattern as #2 for `INCOME_OPTIONS` (`none`, `minimal`, `moderate`). Bare English enum strings reach AR/FR/ES users. Recommended fix: locale keys `families_edit.income_none`, `families_edit.income_minimal`, `families_edit.income_moderate` and a small label helper.

4. **`Families.tsx` family card — hardcoded "medical" unit label.**
   In the family card the medical-conditions count is rendered with a literal English unit ("3 medical"). Not wrapped in `t()`. Recommended fix: `{count} {t('families.medical_conditions')}` (key already exists for the form label in `families_edit`; mirror it under `families`).

5. **`FamilyEditModal.tsx:185-188` — `newFamilyId()` is called twice on the same submit.**
   ```
   const family: Family = {
     ...(existing ?? { family_id: newFamilyId() }),
     family_id: existing?.family_id ?? newFamilyId(),
     ...
   ```
   When `existing` is undefined (creating a new family), the spread invokes `newFamilyId()` once, then the property line overrides with a *second* call producing a different ID. Only the second wins, so persistence is correct, but: (a) wasted timestamp/random work on every create; (b) confusing for readers; (c) the discarded ID has been mentioned by ID-generation telemetry in some setups. Recommended fix: assign once before the literal — `const family_id = existing?.family_id ?? newFamilyId(); ... family: { ...(existing ?? {}), family_id, ... }`.

6. **`Families.tsx:90-95` — search does not trim whitespace.**
   `f.head_name.toLowerCase().includes(search.toLowerCase())`. A trailing space in the search box ("Ahmed ") yields zero results because the comparison is literal. Recommended fix: hoist `const q = search.trim().toLowerCase();` and substitute on lines 93–94.

7. **`FamilyDetail.tsx` — recommended_items snapshot fed to AIChat may stale.**
   `familyForAI` is computed at render and passed to `AIChat`. If a delivery completes (in another tab or via the delivery-confirm modal here) between render and the user pressing send, the AI's inline context says "infant formula not present" while the chip is on screen. Recommended fix: re-fetch the family from Dexie inside `AIChat.handleSend` (already done for `recommended_items`) and merge the *full* row, not just the items field.

8. **`CurrentNeedsCard` save — opaque error fallback.**
   The save handler maps `QuotaExceeded` to a friendly string but otherwise prepends the raw Dexie message verbatim ("NotAllowedError: Failed to execute…"). Recommended fix: enumerate likely IDB error names (`AbortError`, `ConstraintError`, `InvalidStateError`) with friendly messages; keep raw text only as a last-resort fallback.

### LIKELY bugs

9. **`AIChat.tsx:194-217` — partial Dexie re-fetch can desync demographics.**
   The chat re-fetches the family fresh and merges only `recommended_items`. Other fields (`member_count`, `last_aid_at`, `medical_conditions`) stay frozen from the initial render. If the user edits demographics via the inline cards, sends a chat, then asks "how many children?", the AI may reply with the pre-edit member count. Recommended fix: replace the merged object with `latest ?? family` so the AI always sees the freshest row.

10. **`EditableMedicalCard.tsx:30-32` — initial state captured at mount, not at edit-start.**
    `const [conditions, setConditions] = useState(family.medical_conditions);` snapshots the array at mount; `startEdit()` then re-syncs. If the family updates between mount and the user clicking Edit, the *first paint* of the form briefly shows stale items before the re-sync runs. Recommended fix: initialise to `[]` and assign inside `startEdit()` only.

11. **`CurrentNeedsCard` save — no synchronous re-entrancy guard.**
    `disabled={saving}` blocks the button at the React layer, but a screen reader / programmatic click can still queue concurrent `db.families.update` calls if React batches state. Recommended fix: a `busyRef = useRef(false)` checked at the top of `save()`, mirroring the pattern in Distribute's `transition()`.

12. **`Families.tsx:56` — full table scan + client-side filter.**
    `db.families.toArray()` loads everything before filtering. Acceptable for ~1k families; janky around 10k. The agent didn't measure but flags it as the obvious bottleneck. Recommended fix: when the search field is non-trivial, use Dexie's `where('head_name').startsWithIgnoreCase(q)` indexed lookup; reserve the full scan for filter-by-priority.

### NEEDS REPRO

13. **Light/dark mode card hover.** The card uses `hover:border-brand/40 hover:bg-surface-light`. With the recently bumped `--surface-light` in light mode this should be visible — but worth a manual check after the latest token change. Concrete test: open Families in light mode, hover a card; the lift should be obvious.

14. **RTL layout of the family card edit/delete buttons.** The card uses `end-3` for the edit button (logical property — should mirror correctly in AR), but neither RTL test scripts nor visual snapshots exist. Manual test in `dir=rtl` recommended.

15. **`useLiveQuery` cleanup race.** Navigating Families → FamilyDetail → back fast enough may resolve a stale Dexie promise on an unmounted component. React will warn in dev. Manual repro: spam-click the back button. (No reproduction yet.)

## Side-effect / cross-feature concerns

- **Family deletion + distribution history.** `db.families.delete()` is a hard delete with no cascade. Any `AidDistribution` record with `family_id` pointing to the deleted family becomes an orphan. The Distribute history grid hits a missing-family fallback (`familyMap.get(...) ?? raw_id`). Recommended approach: soft-delete (add `deleted_at?: string`) like Workers, hide from the Families list and family pickers, keep queryable for history. Mirrors the workers pattern.
- **Priority cache vs. concurrent edits.** When `EditableDemographicsCard.save()` writes back `priority_score / priority_level / ai_reason`, it doesn't compare `last_updated` against the row in the DB — a write from another tab can be silently clobbered. Suggest reading `last_updated` and aborting with a "this family was changed elsewhere — refresh and try again" toast on conflict.
- **AI context refresh on family change.** `AIChat.tsx:194` re-fetches per send but doesn't subscribe to Dexie change events. Cross-tab edits aren't visible until the user types again. Acceptable for v1; flag as future work.
- **Recommended items v8 migration completeness.** The migration handles object/string entries but doesn't validate against `null`/`undefined`. A corrupt row would crash the chip render. Suggest a defensive filter at read time: `.filter((it): it is NeededItem => it && typeof it.name === 'string')`.

## Missing test coverage

- **i18n parity test** for the families/families_edit/family_detail blocks (would have caught #1–#4).
- **Search-trim test** in `test-family-profile.mjs` — single case asserting `search='Ahmed '` matches "Ahmed".
- **Family deletion + orphaned distributions** — assert that deleting a family doesn't break the history page.
- **AIChat cross-edit refresh** — edit demographics → send chat → assert the AI prompt embeds the new values.
- **RTL visual snapshot** of the card and modal in AR.

## Prevention recommendations

1. **i18n CI gate.** A `scripts/qa/check-i18n-parity.mjs` script that loads each locale and asserts every leaf key in EN exists in AR/FR/ES (and is non-empty / not equal to EN unless it's a proper noun). Mirrors the recommendation from the workers report.
2. **Soft-delete for foreign-key entities.** Families, Workers, Users — anything referenced by another table's foreign key should carry a `deleted_at` instead of being hard-deleted. Workers already converted; Families is next.
3. **Centralise enum-label helpers.** A `src/services/labels.ts` exporting `displacementLabel(t, value)` and `incomeLabel(t, value)` so dropdowns + read-only displays share one source of truth and never bypass `t()`.
4. **`busyRef` re-entrancy pattern as a hook.** Both Distribute and Families need this; extract `useBusyGuard()` returning `[isBusy, run]` so future async writes can `await run(() => db.foo.update(...))` and get free de-duplication.
5. **Performance budget for list pages.** Add a Lighthouse / React Profiler sanity check on Families with 1k seeded rows in CI; flag if first interactive > 250 ms.
6. **Linter rule against unwrapped JSX strings.** A custom ESLint rule (or `eslint-plugin-i18next`) flags string literals inside JSX that aren't wrapped in `t()`. Would have caught findings #1, #2, #3, #4 immediately.
