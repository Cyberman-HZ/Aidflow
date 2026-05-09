# Workers Tab Debug Report

Generated 2026-05-09 from a read-only review of `src/pages/Workers.tsx` (771 lines), `src/types/index.ts`, `src/db/database.ts`, `src/services/aiContext.ts`, `src/pages/Distribute.tsx`, and `src/locales/{en,ar,fr,es}.json`.

## Pre-flight

- `npx tsc --noEmit` -> exit 0 (no TypeScript errors).
- `node scripts/qa/test-family-profile.mjs` -> PASSED 44 / FAILED 0.
- `node scripts/qa/test-family-profile-fixes.mjs` -> PASSED 30 / FAILED 0.
- `node scripts/qa/test-distribute.mjs` -> PASSED 55 / FAILED 0.
- No QA script currently exists for Workers (`scripts/qa/test-workers.mjs` is absent).

## Reproduction summary

| User flow | Code path | Expected | Actual |
|---|---|---|---|
| Page load | `Workers.tsx:53-63` `useLiveQuery` -> `db.workers.toArray().sort(localeCompare)` | List sorted by `last_name first_name` | OK |
| Search | `Workers.tsx:120-134` filters by `first_name`, `last_name`, `position`, `phone` | All visible card fields searchable | `email` and `address` are NOT searched (gap) |
| Position filter | `Workers.tsx:122` exact match on `w.position` | OK | OK |
| Add worker | `WorkerForm.handleSave` `Workers.tsx:505-533` -> `db.workers.add` | Validate names + email regex, save | No dedupe, no whitespace-trim before validation (only after); no max-length |
| Edit worker | `WorkerEditForm.handleSave` `Workers.tsx:672-689` -> `db.workers.update` | Same validation as add | Silently no-ops if names empty (no error UI), validates email |
| Delete | `Workers.tsx:219-262` opens `DeleteWorkerModal` -> `db.workers.delete` | Block busy workers, confirm, delete | Busy guard only checks `out_for_delivery`; pending-assignments leave orphan IDs |
| Card display | `WorkerCard` `Workers.tsx:374-481` | Avatar, name, position, contact, busy badge, edit/delete buttons | OK; `stats` prop is received but never rendered |
| Modal | `DeleteWorkerModal` `Workers.tsx:274-368` | dark-teal modal, ARIA dialog, busy/error banners | No Escape-to-close, no focus trap, no initial focus, no body scroll lock |

## Findings

### CONFIRMED bugs

1. **`Workers.tsx:256` — `delete_failed` fallback never appends raw error.**
   Code: `t('workers.delete_failed') ?? 'Could not delete the worker. ' + raw`. `t()` always returns a string (the key on miss), so `??` short-circuits and `raw` is discarded even when the key is missing. With the key present, the trailing space in the EN/AR/FR/ES values (`"Could not delete the worker. "`) is also wasted because nothing gets concatenated. Recommended fix: build the message in two steps — `const base = t('workers.delete_failed', 'Could not delete the worker. '); setDeleteError(base + raw);`.

2. **`Workers.tsx:120-134` — search ignores `email` and `address`.**
   New fields are stored and rendered but the filter only inspects `first_name | last_name | position | phone`. Users searching by email/address will appear to find nothing. Also: the placeholder copy at `en.json:369` still reads `"Search by name, position, or phone…"`. Recommended fix: extend the predicate to include `w.email?.toLowerCase().includes(q)` and `w.address?.toLowerCase().includes(q)`, and update the four locale `workers.search_placeholder` values.

3. **`src/locales/{ar,fr,es}.json:365-387` — only `email/address/invalid_email/delete_*` keys were translated; the other 22 `workers.*` keys remain hardcoded English.**
   Lines 365-387 of each non-EN locale (`edit`, `edit_title`, `save`, `delete`, `search_placeholder`, `all_positions`, `first_name`, `last_name`, `position`, `phone`, `notes`, `notes_placeholder`, `required_names`, `confirm_delete`, `cannot_delete_busy`, `busy_label`, `empty_*`, `stat_*`) are literal English strings. Result: switching to AR/FR/ES shows half-translated UI. Recommended fix: translate those keys per locale.

4. **`Workers.tsx:219-229` + `Distribute.tsx:254-262` — busy-guard misses `pending` assignments.**
   `busyByWorkerId` only flags `out_for_delivery`. A worker assigned to a `pending` order can be deleted with no warning, leaving `distribution.assigned_to = "W-…"` pointing at a tombstone. The order then shows the raw `W-…` id (`Distribute.tsx:2434`) and `aiContext.workersBlock` drops the assignment from the worker stat map (`aiContext.ts:177-178`). Recommended fix: include `pending` in the busy map (or a separate "has-active-assignment" set) and surface it in the modal as a soft warning that lets the user choose to reassign or cancel pending orders before deletion.

5. **`Workers.tsx:79-98` — `stats` `useMemo` runs on every distributions update but is never displayed.**
   The card no longer renders stats (the prop is passed at line 211 but the `WorkerCard` body does not destructure `stats`). For an org with thousands of historical distributions and dozens of workers, this is a wasted O(W + D) recompute on every Dexie write. Recommended fix: delete the `stats` block + the prop. The AI assistant computes its own stats independently in `aiContext.ts:170-184`, so removing the page-level computation has no side-effect.

6. **`Workers.tsx:672-689` — edit form swallows the empty-name case with no UI feedback.**
   `if (!firstName.trim() || !lastName.trim()) return;` returns silently — no `setError`, no toast. The user clicks Save and sees nothing happen. Compare to the add form (`Workers.tsx:507-510`) which sets an error. Recommended fix: replace the bare `return` with `setError(t('workers.required_names')); return;`.

7. **`DeleteWorkerModal` `Workers.tsx:274-368` — accessibility / UX gaps on the new modal.**
   - No `Escape` key listener, no focus trap, no initial-focus on the cancel button — keyboard users cannot dismiss the dialog without a mouse.
   - No `useEffect` body-scroll lock, so the page behind scrolls on touch devices.
   - The overlay click-to-close (line 298) doubles as a touch surface — on mobile a stray tap dismisses the dialog. Combined with the next finding this is a real foot-gun.
   - `aria-describedby` is not set on the dialog even though the description has a stable position. Recommended fix: add a `useEffect` that wires `keydown` for Escape, focuses the cancel button on mount, and sets `document.body.style.overflow = 'hidden'`; add `aria-describedby` pointing to the body `<p>`.

### LIKELY bugs

8. **`Workers.tsx:155` — no duplicate-worker guard.**
   `db.workers.add(w)` happily inserts two rows with identical `first_name + last_name + position`. Two workers named "Layla Othman, Field Worker" are indistinguishable in dropdowns. Likely fix: a soft warning if a same-name+position record exists; the existing `position, last_name, first_name` index in `database.ts:120` makes this a single `where().equals()` lookup.

9. **`Workers.tsx:505-533` — no input-length cap.**
   A user (or paste accident) can store a 50,000-char name. The card uses `truncate` so it renders OK, but the AI prompt (`aiContext.ts:196`) embeds the full name into the system prompt unchecked, blowing past Gemma 4's small context. Likely fix: clamp each text field to 80 chars on save.

10. **`Workers.tsx:46-48` — `newWorkerId` collisions are theoretically possible.**
    `Date.now().toString(36) + Math.random().toString(36).slice(2,5)` gives only 3 random alphanumeric chars (~46k space) per millisecond. Two synchronous `add` calls in the same ms (e.g. bulk import) could collide and the second `add` would throw "ConstraintError" with no UI feedback. Likely fix: widen to `slice(2, 10)` or use `crypto.randomUUID()`.

11. **`Workers.tsx:710-723` — `position` state is typed `string`, allowing legacy free-text positions to round-trip but losing the literal-union safety on save (`Workers.tsx:683` casts back to `WorkerPosition`). If a worker was migrated from v7 with a custom position string outside `POSITIONS`, the `<option value={position}>` (line 720-722) is shown but selecting any standard position then saving silently overwrites the custom value with no confirmation.

### NEEDS REPRO

12. **Modal close while delete is in flight.** `onCancel` (line 241-245) early-returns if `deletingNow` is true, but the overlay `onClick` (298-300) checks `deleting` (the prop, same value) — OK. However if the user toggles RTL during a slow delete, the `onClick` capture phase may differ. Worth manual test in AR with Dexie throttled.

13. **Phone validation absent.** A user can save `phone: "abc"`. The `tel:` href on line 431 then yields `tel:abc` which most dialers reject silently. Reproduce on Android Chrome.

14. **RTL in the modal.** The icon at line 307 uses `flex-shrink-0` but no `start/end` margin — needs visual check at `dir=rtl`.

## Side-effect / cross-feature concerns

- **Worker deletion + historic distributions.** `db.workers.delete` does NOT cascade. `Distribute.tsx:2434` falls back to the raw `W-…` id (so the History row shows "by W-mdwq2-abc"); `aiContext.ts:177` silently drops orphan assignments from worker totals. Any AI question about historic deliveries by the deleted worker returns "no data" instead of "this worker is no longer in the team but delivered N orders". Recommended approach: soft-delete (add `deleted_at?: string`) instead of hard-delete, keep the row queryable for history, hide it from selectors.
- **Worker deletion + active pending orders.** Per finding #4, no guard.
- **Worker rename + AI context cache.** `aiContext.ts:34-47` rebuilds the snapshot on every prompt build, so renames propagate; no caching layer to invalidate. OK.
- **Performance on large worker lists.** Per finding #5, the page recomputes stats over every distribution on every Dexie change; the data is never shown. With 100 workers and 10k orders this is a 1M-iteration map rebuild per write.
- **Settings reset.** `database.ts:202-217` `clearAll` includes `workers.clear()` — a reset wipes workers cleanly. OK.
- **Seed data.** `seedData.ts` references `db.workers.bulkAdd`; nothing requires the new `email/address` fields, so seed survives. OK.

## Missing test coverage

- No `scripts/qa/test-workers.mjs` exists. Suggested unit tests:
  1. `email` regex validator (good + bad emails, including "@" only, IDN, +alias).
  2. Search predicate covers email & address (after fix #2 lands).
  3. Busy-guard treats `pending` and `out_for_delivery` consistently (after fix #4).
  4. `DeleteWorkerModal` Escape-key + focus-on-mount (jsdom) (after fix #7).
  5. `newWorkerId` uniqueness over a 1000-call burst (after fix #10).
- The existing `test-distribute.mjs` already asserts the `busyByUserId` derivation in Distribute (line "busyByUserId: derived from live query"), but does not test the parallel structure in Workers.

## Prevention recommendations

1. **Centralize worker-busy logic.** Both `Workers.tsx:100-108` and `Distribute.tsx:254-262` hand-build the `busyByWorkerId` map with subtly different semantics (Workers also feeds pending guard; Distribute does not). Extract `getBusyWorkers(orders): Map<string, AidDistribution>` to `src/services/workers.ts` so the rule is single-sourced.
2. **i18n CI gate.** Add a script (`scripts/qa/check-i18n-parity.mjs`) that loads each locale and asserts every leaf key present in EN exists in AR/FR/ES (and vice versa) and is non-empty / not-equal-to-EN-when-EN-is-not-a-proper-noun. Would have caught finding #3 immediately.
3. **Prefer soft-delete for entities referenced by foreign keys.** Workers, Families, Users — any entity referenced by `assigned_to` / `delivered_by` / etc. should carry a `deleted_at` instead of being hard-deleted.
4. **Linter rule against unused props.** `react/no-unused-prop-types` would have flagged `stats` on `WorkerCard` after the recent display change.
5. **Constrain text inputs at the type / form layer.** A shared `<TextInput maxLength=80>` used across Workers and Families would close findings #9 and several historic length-related bugs.
6. **Accessibility checklist for new modals.** `DeleteWorkerModal` is the second in-app confirm modal in this codebase; turning the recurring requirements (focus trap, Escape, scroll lock, ARIA) into a `<ConfirmDialog>` primitive would prevent re-discovery of finding #7 next sprint.
