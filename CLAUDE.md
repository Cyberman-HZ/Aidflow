# CLAUDE.md — Session handoff for AidFlow Pro

This file is the entry point for the next Claude session (or any new
contributor). Read it before doing anything else. It captures everything
the previous session can't easily rediscover: the project's purpose, the
architecture, the load-bearing decisions, the in-flight work, and the
user's preferences.

---

## 1. Project at a glance

**AidFlow Pro** is an **offline-first humanitarian aid coordination
console** built for the **Gemma 4 Good Hackathon** (Kaggle, in
partnership with Google DeepMind).

- **Track:** Global Resilience (secondary alignment to Safety & Trust)
- **Model:** `gemma4:e4b` (Gemma 4 E4B, ~8 B parameters, ~5 GB) served
  locally via **Ollama** on `http://localhost:11434`. Plus
  `nomic-embed-text` for the RAG embeddings (optional — keyword fallback
  exists).
- **Inference:** never leaves the laptop. No cloud, no per-seat
  license, no monthly bill. The internet may be on / off / flaky — the
  workflow never changes.
- **Stack:** React 18 + TypeScript (strict) + Vite + Tailwind + Dexie
  (IndexedDB) + Workbox (PWA) + react-i18next + Recharts + lucide-react
  + Zustand.
- **Hackathon deadline:** **2026-05-18** (today is 2026-05-12 in the
  context the previous session was operating in — check the actual date
  before quoting it back to the user).
- **Repo:** https://github.com/Cyberman-HZ/Aidflow (public, MIT licensed)

The user's GitHub handle is `Cyberman-HZ` and they work on **Windows
with PowerShell**. The dev server runs from
`F:\Gemma 4 project\Humanitarian aid distribution AI` (the primary
clone — there are no other worktrees right now).

---

## 2. Architecture summary

```
   ┌─────────────────────────────────────────────────────────┐
   │  AidFlow Pro PWA  (React 18 + TypeScript + Tailwind)    │
   │                                                         │
   │  ┌──────────────────────────────────────────────────┐   │
   │  │ Coordinator UI                                   │   │
   │  │   Dashboard  /  Families  /  Family Detail  /    │   │
   │  │   Distribute /  Assistant /  Knowledge Base /    │   │
   │  │   Kids       /  Bitchat   /  Starlink     /      │   │
   │  │   Workers    /  Settings                         │   │
   │  └────────────┬───────────────────┬─────────────────┘   │
   │               │                   │                     │
   │  ┌────────────▼─────────┐  ┌──────▼────────────┐        │
   │  │  Local DB            │  │  AI services      │        │
   │  │  (Dexie / IndexedDB) │  │  - chatWithTools  │        │
   │  │                      │  │    (function call)│        │
   │  └──────────────────────┘  │  - chatWithImage  │        │
   │                            │    (multimodal)   │        │
   │                            │  - RAG pipeline   │        │
   │                            │  - priority rules │        │
   │                            └──────┬────────────┘        │
   │                                   │                     │
   │      ┌────────────────────────────▼────────────┐        │
   │      │  fetch  →  http://localhost:11434       │        │
   │      │             Ollama  →  gemma4:e4b       │        │
   │      └─────────────────────────────────────────┘        │
   └─────────────────────────────────────────────────────────┘
```

### Three Gemma-4-specific features (the hackathon story)

1. **Native function calling** — 11-tool catalog
   (`src/services/aiTools.ts`) shipped to Gemma 4 via Ollama's `tools`
   parameter. Read tools (`get_family`, `find_families`,
   `get_distribution_history`, `list_active_orders`, `find_workers`)
   auto-execute. Write tools (`update_family_field`,
   `add/remove_family_need`, `add/remove_medical_condition`,
   `draft_dispatch_order`) bubble up as Apply / Discard cards in
   `AIChat.tsx`. The model can never mutate state directly. Multi-step
   loop bounded at 5 rounds.
2. **Multimodal paper-form ingest** — admin photographs a paper
   registration list; `formIngest.ts` sends the resized image to Gemma
   4 vision via `chatWithImage` with `format: json`, validates the
   structured response, and each row appears as an editable Apply /
   Discard card in `PaperFormImport.tsx`. The image never leaves the
   laptop. Camera capture uses `getUserMedia` (live webcam preview
   stage) — `<input capture="environment">` is desktop-broken so we
   replaced it.
3. **Explainable priority triage** — Gemma 4 receives a JSON snapshot
   of every family and returns score / level / reason /
   recommended_items. Deterministic rule-engine fallback
   (`priorityRules.ts`) runs the same rubric offline. Re-ranks after
   every delivery.

Other AI features powered by Gemma 4: RAG knowledge base (citation +
out-of-corpus refusal); spreadsheet column mapping; AI executive
summary on the Dashboard (includes a Registry-deletions section);
AI-explained per-family chat scoped to one family record;
AI-generated emotional-support content for displaced children.

### Privacy contract (load-bearing for the pitch)

- All inference on `localhost:11434`. **No data leaves the laptop.**
- Photo bytes for paper-form ingest are kept in-memory only and dropped
  after extraction.
- Wikipedia search is opt-in per question and sends only the question,
  never family data.
- The data layer is isolated in `src/db/` + `src/services/` so a real
  org can swap IndexedDB for a server.

---

## 3. Build, test, lint commands

This is a **Windows + PowerShell** environment. Default file encoding
in PowerShell is UTF-16-LE — when writing files other tools read,
pass `-Encoding utf8` explicitly.

### One-time setup

```powershell
# Pull Gemma 4 model (~5 GB)
ollama pull gemma4:e4b

# Pull embeddings model (optional — keyword fallback exists)
ollama pull nomic-embed-text

# Start Ollama with browser-CORS allowed (REQUIRED)
$env:OLLAMA_ORIGINS="*"; ollama serve

# In another terminal:
npm install
npm run dev   # → http://localhost:5173
```

### Day-to-day commands

| What | Command | Notes |
|---|---|---|
| Dev server | `npm run dev` | Vite on http://localhost:5173, HMR live |
| Typecheck | `npx tsc --noEmit -p tsconfig.json` | **Use `-p tsconfig.json` explicitly**. `tsc -b --noEmit` errors out because `tsconfig.node.json` can't disable emit. exit 0 = clean. |
| Production build | `npm run build` | Runs `tsc -b && vite build`. Output in `dist/`. Currently ~2478 KiB precache. |
| Preview build | `npm run preview` | http://localhost:4173 |
| Strip dead comments | `npm run clean:src` | Custom script in `scripts/clean-source.mjs` |
| Lint | `npm run lint` | **No real lint** — placeholder echo. Don't rely on it. |
| QA suite (live, needs Ollama) | `node scripts/qa/test-tool-calls.mjs` | Live function-calling round-trip against gemma4:e4b |
| QA suite (live, needs Ollama) | `node scripts/qa/test-paper-form-ingest.mjs` | Live vision round-trip against gemma4:e4b |
| QA suite (static) | `node scripts/qa/test-family-delete.mjs` | 137 assertions for delete + audit log |
| QA suite (static) | `node scripts/qa/test-import-no-autoseed.mjs` | 28 assertions for the no-auto-invent invariant |
| QA suite (static) | `node scripts/qa/test-duplicate-prevention.mjs` | 84 assertions for duplicate-family prevention |

### Bash-tool quirks in this environment

The shell's cwd persists across calls **but resets to a removed
worktree** sometimes — always prefix Bash commands with
`cd "F:/Gemma 4 project/Humanitarian aid distribution AI"` or use
absolute paths in tool calls. The previous session learned this the
hard way.

### Direct push to `main` is blocked by the harness

The Bash tool refuses `git push origin <branch>:main` with:
> "Pushing directly to the remote default branch (main) bypasses pull
> request review."

**Always push to a feature branch and have the user merge the PR on
GitHub.** Branch deletion (`git push origin --delete <branch>`) is
allowed.

---

## 4. State of Play — 2026-05-12 (latest)

### Session 2 addendum (since the previous handoff was written)

**PR #5 (`feature/dedupe-imports-and-cleanup`) has been MERGED into `main`.**
Everything listed under the old "What's IN FLIGHT" section below is now
on `origin/main`. Local `main` is in sync with origin (0 commits ahead,
0 behind).

**Uncommitted local changes (on `main`, not yet committed or pushed):**

```
M public/logo.png                 ← user uploaded a new logo asset
M src/components/Layout.tsx       ← logo refactor (see below)
M src/pages/Login.tsx             ← logo refactor (see below)
M src/pages/KnowledgeBase.tsx     ← cosmetic-only (synthesis feature
                                    added then fully reverted; net diff
                                    is a couple of blank lines)
?? CLAUDE.md                      ← this file
```

Run `git diff src/pages/KnowledgeBase.tsx` to confirm — the diff should
be only whitespace / a stray blank line near the seam where the
SynthesisCard used to sit. Safe to commit either way.

#### Work landed in session 2

1. **Logo presentation refactor — three places**

   The `public/logo.png` artwork already contains the "AIDFLOW" wordmark.
   The previous UI rendered `<img>` + a separate `app.name` text label
   next to it, which was a visible duplicate. Refactor:

   - **`src/components/Layout.tsx`** — desktop sidebar header: removed
     the `app.name` + `app.tagline` text block, grew the container from
     `h-20` to `h-28`, grew the logo from `h-10` to `h-24`, reduced
     horizontal padding to `px-2`, centered the logo. Also bumped the
     nav's height-calc from `100vh − 4rem` to `100vh − 7rem` to keep
     in sync with the new header height. Mobile header: same treatment
     scaled smaller (`h-8` → `h-11`).
   - **`src/pages/Login.tsx`** — login screen: removed the `app.name`
     `<h1>` + tagline `<p>` below the logo, grew the logo from `h-20`
     to `h-32`.
   - **Fallback paths preserved** — if `/logo.png` is ever missing, the
     fallback still shows a small letter tile + brand text (the
     fallback is the only case where text alongside an icon is
     correct — the letter tile has no wordmark of its own).

2. **Cross-document synthesis: feature considered, built, and removed
   on user request.**

   The Assistant page's capabilities reply has long advertised
   *"Cross-document synthesis across your whole library at once."* The
   user asked whether that was a real feature. Investigation showed:

   - `prepareRagPrompt` in `rag.ts` has a library-wide route hidden
     behind `isSummarizeIntent` chat-magic-words — works, just not
     discoverable.
   - **The chat panel's normal RAG retrieval (`retrieve()` at
     `rag.ts:147`) already pulls chunks from EVERY document, scores
     globally, and returns top-k regardless of source document.** So
     any question whose answer spans multiple PDFs gets a
     multi-document answer with multi-document citations. That IS
     cross-document synthesis in practice — it's just question-driven
     rather than button-driven.

   A dedicated `synthesizeLibraryStream` function + `SynthesisCard` UI
   was built and merged via testing flow. After seeing the chat already
   delivered the desired behavior (4 PDFs cited in a single answer),
   the user asked to remove the button — they wanted no redundant
   surface. Removed cleanly:
   - `synthesizeLibraryStream` + `SYNTHESIS_SYSTEM_PROMPT` +
     `SynthesisCitation` from `rag.ts`
   - `SynthesisCard` component + render block + extra icon imports
     (`Layers`, `RefreshCw`) from `KnowledgeBase.tsx`
   - 9 `knowledge.synthesis_*` locale keys × 4 languages
   - `scripts/qa/test-library-synthesis.mjs`

   See Invariant 11 below — **do not add a dedicated synthesis button
   back**. The chat is the canonical surface.

3. **Investigation-only discussions (no code change):**
   - The "no fine-tuning, no eval harness" question — concluded that
     these are NOT what the project is missing for the hackathon; the
     remaining gap is submission artifacts (video, cover image, Kaggle
     Notebook).
   - Kaggle entry title + subtitle — final picks:
     - **Title:** `AidFlow Pro` (11 chars)
     - **Subtitle:** *"Humanitarian aid coordination Gemma 4 powered
       webapp that runs offline even on modest hardware"* (96 chars).
       (User picked a slightly different polished version of the
       capability-led options I drafted.)
   - Kaggle thumbnail / cover image — required at **560 × 280**
     dimensions per the actual Kaggle form (verified from a screenshot
     the user shared). My recommendation: three-panel banner (paper-
     form ingest + function-call Apply card + Dashboard AI summary
     + deletion audit) with the tag lockup `AidFlow Pro · Gemma 4 ·
     Offline · Multilingual` bottom-right. Single-screenshot
     alternative: Family Detail page hero with the CRITICAL · 100
     badge, the "Imported from paper form via Gemma 4 vision" note,
     and the scoped AI chat panel all in frame.

### Hackathon deliverables still missing (deadline 2026-05-18)

Unchanged from the previous handoff. Code is ready; submission package
(video, cover image, Kaggle Notebook write-up, identity verification)
is not.

---

## 4-OLD. State of Play — 2026-05-12 (prior handoff snapshot)

### What just landed on `origin/main` (already merged)

Last 4 merged PRs in chronological order:

1. **PR #1** `feature/gemma4-function-calling` — Native Gemma 4 function
   calling. 11-tool catalog + `chatWithTools` + Apply/Discard UI in
   `AIChat.tsx`. Live-verified against `gemma4:e4b`.
2. **PR #2** `chore/hackathon-repo-cleanup` — Repo hygiene: dropped
   scratch files (`test-big.txt`, `test_sync*.txt`), moved internal
   audits under `docs/internal/`, moved planning PDF to `docs/`.
3. **PR #3** `feature/delete-audit-and-cleanup` — Family delete audit
   (in-app DeleteFamilyModal with required reason, Dashboard audit log
   showing name+ID+reason, AI summary "Registry deletions" section).
   Repo cleanup: orphan files (nominatim/osmProviders/
   SpreadsheetImportModal), unused npm deps (leaflet, react-leaflet,
   @types/leaflet, workbox-window). README rewrite (AI-only features
   table; merged problem+solution section).
4. **PR #4** `chore/strip-internal-audits` — Deleted `docs/internal/`
   (5 dev-time audit / debug `.md` files).

### What's IN FLIGHT — open PR pending merge

> **UPDATE (session 2):** PR #5 has been merged. The branch is gone.
> Section content kept below for historical record.

**Branch:** `feature/dedupe-imports-and-cleanup`
**URL:** https://github.com/Cyberman-HZ/Aidflow/pull/new/feature/dedupe-imports-and-cleanup
**Commit:** `0d950f9` (22 files changed, +1064 / −2309)

This PR bundles **everything done in the most recent session** before
this handoff. Contents:

#### A. Duplicate-family prevention (3 creation paths)

A family is now a duplicate when both `head_name` (trimmed,
whitespace-collapsed, `toLocaleLowerCase`'d) AND `member_count` match
a non-deleted existing family. Soft-deleted families are excluded
(intentional re-registration).

- **`src/services/familyDuplicates.ts`** (new) — exports
  `normalizeHeadName(name)`, `findDuplicateFamily(name, count,
  excludeId?)` (Dexie-backed, async), `findDuplicateFamilySync(arr,
  ...)` (in-memory variant for React components).
- **`FamilyEditModal.tsx`** — blocks save in manual + spreadsheet
  wizard paths. Surfaces an inline error citing the existing
  `family_id`. `excludeId=self` on the edit path.
- **`formIngest.ts`** — exports `DuplicateFamilyError` class.
  `commitFamilyCandidate` throws it when matched (caught by
  PaperFormImport's onApply, rendered as "Could not apply").
- **`PaperFormImport.tsx`** — pre-flight via `useLiveQuery`. Each
  candidate card subscribes to live families and renders a red
  "Duplicate of an existing family" banner with disabled Apply button
  the moment name/count match an existing row. Edits in the card
  re-evaluate immediately.

#### B. Imports no longer auto-invent need items

The rule engine *suggests* items from demographics — useful as a UI
hint, not as a fact. Previous code persisted those suggestions onto
imported rows.

- **`formIngest.ts`** — `commitFamilyCandidate` no longer copies
  `scored.recommended_items` onto the row.
- **`FamilyEditModal.tsx`** — save handler no longer seeds
  `family.recommended_items` from `computeRuleScore`. Edits preserve
  existing items implicitly via the `...existing` spread.
- **`Families.tsx`** — list row reads ONLY `family.recommended_items
  ?? []`. The previous `result?.recommended_items` fallback is gone.
- **`FamilyDetail.tsx`** — removed the `fallbackItems` prop from
  `CurrentNeedsCard`. Family row is the single source of truth. AI
  system prompt for the scoped chat also reads from `recommended`
  directly (no fallback).
- **`seedData.ts`** — seeded demo families pass through a one-shot
  `computeRuleScore` mapping at seed time so they ship with explicit
  `recommended_items`. Without this the demo cards would render empty
  Current Needs sections on first load.

#### C. UX polish in PaperFormImport

- **45** broken `t('key') ?? 'default'` calls converted to the proper
  `t('key', 'default')` two-arg form. i18next returns the KEY string
  when missing (truthy), so the `??` fallback never fired — that's why
  raw `common.apply` / `common.discard` strings leaked through.
- Added `common.apply`, `common.discard`, `common.retry` to all 4
  locales.
- "Apply all remaining" footer button now only renders when **2+
  candidates pending** (was a visual duplicate of the per-card Apply
  with one card).
- PowerShell regex pass mangled one apostrophe inside `"Don't"` — fixed
  manually with double-quoted fallback.

#### D. Duplicate-warning banner moved to top of FamilyEditModal

The duplicate error used to render just before the modal footer (below
the optional GPS-coordinates section). On a tall form on small screens
it scrolled off. Now pinned at the top of the scrollable form body —
visible the instant a save is blocked.

#### E. Repo trim

- **Deleted `CLAUDE.md`** — the user wanted a cleaner public repo.
  (This new CLAUDE.md is a session-handoff doc, not the old "project
  briefing" — keep this one out of the public repo if the user asks
  for another cleanup pass, OR add it to `.gitignore`.)
- **Deleted 7 older QA scripts** that covered already-shipped features:
  - `test-distribute.mjs`
  - `test-emotional-support.mjs`
  - `test-families-fixes.mjs`
  - `test-family-profile.mjs`
  - `test-family-profile-fixes.mjs`
  - `test-knowledge-base.mjs`
  - `test-spreadsheet-import.mjs`
- **Kept** the 5 QA scripts with demo / regression value:
  - `test-tool-calls.mjs` (live, demo-able)
  - `test-paper-form-ingest.mjs` (live, demo-able)
  - `test-family-delete.mjs` (static, 137 assertions)
  - `test-import-no-autoseed.mjs` (static, 28 assertions)
  - `test-duplicate-prevention.mjs` (static, 84 assertions)
- **README file-tree updated** to match the new layout (removed
  CLAUDE.md, removed the 7 deleted QA scripts, added
  `familyDuplicates.ts`).

### What the user needs to do next

1. **Merge the open PR** at the URL above. Clean fast-forward.
2. **After merge:**
   ```bash
   git checkout main
   git pull origin main
   git push origin --delete feature/dedupe-imports-and-cleanup
   git branch -d feature/dedupe-imports-and-cleanup
   ```

### Hackathon deliverables still missing (deadline 2026-05-18)

The **code** is ready. The **submission package** isn't:

- [ ] **3-minute demo video** — highest priority artifact. Suggested
      structure:
      0:00–0:20 vignette (the diabetic-teenager-three-streets-away from
      the README), 0:20–1:00 paper-form ingest live, 1:00–2:00 function
      calling chain ("find critical WASH families with no delivery in
      7 days, draft dispatches"), 2:00–2:40 pull the network cable on
      camera (offline money shot), 2:40–3:00 Arabic moment +
      attribution.
- [ ] **Cover image** — required by Kaggle. Composite of Dashboard +
      Family Detail + Apply/Discard card.
- [ ] **Kaggle Notebook write-up** — mostly mirrors the README in
      Kaggle's format.
- [ ] **3–5 hero screenshots** under `docs/screenshots/` referenced
      from README.
- [ ] **Identity verification** on Kaggle (admin task; can't see from
      Claude).

The previous session advised the user to **stop chasing edge-case
bugs and switch to packaging the submission.** Stick to that.

---

## 5. Load-bearing patterns + invariants (do not break)

These are subtle decisions the previous session encoded after specific
user requests. Re-introducing the old behavior would be a regression.

### Invariant 1 — Imports must not auto-invent need items

The rule engine's `recommended_items` output is a UI HINT, not a fact.
**No creation path writes it to the DB row.** The previous session
fixed this in three places (formIngest, FamilyEditModal save, removed
UI fallback in Families.tsx + FamilyDetail.tsx). If you find yourself
wanting to "helpfully populate items from demographics", **don't.**
The Edit button on `CurrentNeedsCard` is the only path for real items.
Seeded demo families get items at seed time so the demo doesn't
degrade — that's the only exception.

Test: `node scripts/qa/test-import-no-autoseed.mjs`.

### Invariant 2 — No duplicate families across any creation path

Match rule: `head_name` (trimmed, whitespace-collapsed,
`toLocaleLowerCase`'d) AND `member_count` against non-deleted
families. Excluded for the edit path via `excludeId`. Enforced at
every entry point — `FamilyEditModal.handleSave`,
`commitFamilyCandidate`, and pre-flight in `PaperFormImport`.

Test: `node scripts/qa/test-duplicate-prevention.mjs`.

### Invariant 3 — Pen icon is the only edit affordance on the Families list

The user explicitly removed the "click the card" navigation. The card
body is presentation-only; the pen icon links to the family detail
page (which has its own inline editors). Don't restore card-click
navigation without asking.

### Invariant 4 — Soft delete only, with mandatory in-app reason modal

Families and workers get `deleted_at` stamped, never hard-deleted, so
historic `AidDistribution.family_id` references stay coherent.
`DeleteFamilyModal` requires a reason (≥4 trimmed chars). No native
`window.confirm` / `window.prompt` anywhere — they fail on PWAs +
mobile and don't accept input.

### Invariant 5 — Function-calling write tools never mutate state directly

`aiTools.ts` partitions tools into `read` (auto-executed) and `write`
(bubble to Apply/Discard card). The model cannot bypass user
confirmation. The `chatWithTools` loop responds to write proposals
with `{"status":"proposed_to_user"}` so the model stops looping. Max
5 rounds.

### Invariant 6 — Locale fallback pattern

**Use `t('key', 'Default text')`, never `t('key') ?? 'Default text'`.**
i18next returns the KEY string when a translation is missing — that's
truthy, so `??` never falls back. This bit the previous session
hard (raw `common.apply` leaked into the UI). The local `T` type alias
in `PaperFormImport.tsx` is `ReturnType<typeof useTranslation>['t']` —
do not hand-model it; the real overloads are hairy.

### Invariant 7 — `getUserMedia` for camera, not `<input capture>`

`<input type="file" capture="environment">` is silently ignored on
desktop browsers — they fall back to the file picker. Use
`navigator.mediaDevices.getUserMedia` with a `CameraStage` (live
video preview + Snap button + Flip + Cancel). Cleanup must stop every
track in the stream (camera-light-off discipline). See
`PaperFormImport.tsx`.

### Invariant 8 — Nested modals: stop click propagation

`PaperFormImport` renders inside `FamilyEditModal`. The outer modal's
backdrop has `onClick={onClose}`. The inner modal's outermost div
**MUST** have `onClick={(e) => e.stopPropagation()}` (and the same for
onChange) or every click in the inner modal will close the outer one
and unmount the inner. The previous session learned this when "pick a
file" stopped working.

### Invariant 9 — README structure is canonical

The README has been hand-curated by the user:

1. Title + 5 badges
2. `## 1. The problem & the solution` (merged problem + solution, ~5 lines)
3. `## 2. AI-powered features` (single 9-row table, AI features only)
4. `## 3. Install and run` (5 numbered steps + gotchas table)
5. `## 4. Project file structure` (file tree)
6. `## Hackathon submission`
7. `## License`
8. `## Attribution`

Do **not** add Glossary / "What this project is not" / Acknowledgements
back — the user explicitly removed them. Don't add non-AI features
into the section 2 table — the user explicitly excluded them.

### Invariant 10 — Direct push to `main` is blocked

The harness refuses direct main push. Always feature-branch + PR.

### Invariant 11 — Cross-document synthesis lives in the chat, NOT a button

The Knowledge Base chat panel's RAG retrieval already pulls chunks from
**every** document and answers across multiple sources naturally (the
user verified this with a screenshot showing 4 PDFs cited in one
response). A dedicated "Synthesize whole library" button was built and
then **removed at user request** as redundant UI. Do not add it back.

The chat-magic-word route inside `prepareRagPrompt` that handles
`isSummarizeIntent` still exists for typed prompts like "summarize the
library" — that's the canonical way to trigger a library-wide overview
if anyone needs one.

### Invariant 12 — Logo image carries the wordmark; no sibling text label

`public/logo.png` is a vertical lockup that already contains the
"AIDFLOW" wordmark. The UI must NOT render `app.name` / `app.tagline`
text next to the logo — the previous design did and was visibly
redundant. Three render sites must stay text-free:

- **Desktop sidebar header** (`Layout.tsx`) — `h-28` container,
  `h-24` logo, centered, no text
- **Mobile top header** (`Layout.tsx`) — `h-11` logo, no text
- **Login screen** (`Login.tsx`) — `h-32` logo, no text

The fallback letter-tile path (shown only when `/logo.png` is missing)
keeps its small `app.name` label — that case is the only one where
text alongside an icon is correct because the letter tile has no
wordmark of its own.

---

## 6. Recent bug-fix history (don't re-introduce)

Each line is a previously-fixed bug. The fix is in the relevant file;
this is just a "watch out for" list.

| When | Bug | Fix location |
|---|---|---|
| 2026-05-12 (s2) | Dedicated "Synthesize whole library" button was redundant with the chat's existing cross-document RAG behavior | removed `SynthesisCard` + `synthesizeLibraryStream` + 9×4 locale keys + the QA test; chat is canonical |
| 2026-05-12 (s2) | Logo + "AidFlow Pro" / tagline text rendered side-by-side — the logo image already contains the wordmark | dropped sibling text in Layout.tsx (desktop sidebar + mobile header) and Login.tsx; grew the logo in all three |
| 2026-05-12 | Duplicate warning rendered at bottom of FamilyEditModal, scrolled off-screen | banner moved to top of scrollable form body |
| 2026-05-12 | Raw `common.apply` / `common.discard` strings leaking through in PaperFormImport | added the keys + converted `?? 'X'` → `t(k, 'X')` everywhere |
| 2026-05-12 | "Apply all remaining" button visible with 1 candidate (duplicate of card Apply) | only renders when `pending + failed >= 2` |
| 2026-05-12 | UI fallback to rule-engine items even when DB row had none | removed fallback in Families.tsx + FamilyDetail.tsx; seedData runs the rule engine at seed time |
| 2026-05-12 | `commitFamilyCandidate` auto-populating `recommended_items` from the rule engine | line removed |
| 2026-05-12 | `FamilyEditModal.handleSave` auto-seeding `recommended_items` for new families | block removed; edits still preserve via `...existing` |
| 2026-05-12 | Could create the same family multiple times | duplicate prevention across all 3 paths |
| 2026-05-11 | "Use camera" opened the file picker instead of the webcam | replaced `<input capture>` with `getUserMedia` + CameraStage |
| 2026-05-11 | Clicking inside PaperFormImport closed FamilyEditModal | `stopPropagation` on PaperFormImport's outermost div |
| 2026-05-11 | Card-click on Families list opened detail (two edit paths) | removed Link wrapper on card body; pen icon is the only nav |
| 2026-05-11 | Stale gitlinks (`.claude/worktrees/*`) on origin/main rendering as broken submodules | `git rm --cached`; `.gitignore` has `.claude/worktrees/` |
| 2026-05-10 | Fenced-`aidflow-action` JSON protocol was the only AI-edit path | replaced with Ollama native `tool_calls` (kept the regex path as fallback) |

---

## 7. User preferences (calibrated from this session and earlier)

These are stylistic / behavioral preferences the user signaled. Honor
them unless they say otherwise.

- **Auto mode is on.** Execute immediately. Don't ask before low-risk
  refactors. Do ask before destructive actions on shared/remote
  systems.
- **No emojis in files unless explicitly requested.** The README has
  emojis because the user asked for them. CLAUDE.md (this file) should
  not, by default.
- **PowerShell is the user's shell.** When suggesting commands give
  both PS and Bash if practical, or PS-first.
- **Strict in-app dialogs, never `window.confirm` / `prompt`** —
  doesn't accept input, fails on PWAs.
- **One source of truth per data point.** The user dislikes
  "helpful" auto-fills that pretend to be data (see the
  recommended_items saga).
- **Honest UX.** Empty-state should say "no items yet", not
  invent items. Cards that aren't clickable shouldn't have hover
  styles that suggest they are.
- **Verify before claiming.** When asked "is this ready?" the user
  wants an honest calibrated answer, including what's not done. They
  pushed back when the previous session said "fixed" but only the DB
  was fixed and the UI fallback was still rendering.
- **Hackathon-ready means complete, not perfect.** The user knows the
  remaining 6 days matter more for video + write-up than for edge-case
  bug-fixing. Reinforce this if they keep asking for bug fixes.
- **Wants the repo clean.** Has done multiple cleanup rounds. If you
  add a file, justify why it's not noise.
- **Talks about features by user-facing name, not file name.** Speak
  the user's language ("the photo import card", "the trash button").

---

## 8. File map (quick reference)

The full annotated tree is in `README.md` section 4. Highlights:

**AI services (most-touched in this hackathon):**
- `src/services/ollama.ts` — Ollama client (`chat`, `chatStream`,
  `chatWithTools`, `chatWithImage`, `embed`, `prioritizeFamilies`)
- `src/services/aiTools.ts` — function-calling tool catalog (11 tools)
- `src/services/formIngest.ts` — paper-form vision pipeline
- `src/services/imageUtils.ts` — file → resized JPEG → base64
- `src/services/familyDuplicates.ts` — duplicate detection (new)
- `src/services/familyActions.ts` — legacy fenced-JSON protocol (kept
  as fallback for non-tool-calling models)
- `src/services/familyIntent.ts` — regex intent detector (deterministic
  short-circuit for common phrases like "remove water")
- `src/services/rag.ts` — PDF chunk + embed + retrieval + citation
- `src/services/priorityRules.ts` — deterministic rule engine
  (Ollama-offline fallback)
- `src/services/spreadsheetImport.ts` — CSV/XLSX import (Gemma-mapped)

**Stateful UI components:**
- `src/components/AIChat.tsx` — the universal Gemma 4 chat panel
  (Assistant, Family Detail, Knowledge Base). Renders tool-call chips
  and Apply/Discard cards.
- `src/components/FamilyEditModal.tsx` — add/edit family + hosts the
  two import banners (spreadsheet + photo) at the top
- `src/components/PaperFormImport.tsx` — multimodal paper-form modal
  (pick → camera → preview → analyzing → review → done stages)
- `src/components/DeleteFamilyModal.tsx` — in-app delete dialog with
  required reason

**Pages:**
- `src/pages/Dashboard.tsx` — KPIs + charts + AI executive summary +
  Recent family deletions audit card
- `src/pages/Families.tsx` — list view, pen icon → detail
- `src/pages/FamilyDetail.tsx` — Demographics + Medical + Current
  needs + History + scoped AI chat
- `src/pages/Distribute.tsx` — 3-step dispatch wizard
- `src/pages/Assistant.tsx`, `KnowledgeBase.tsx`, `Workers.tsx`,
  `KidsContent.tsx`, `StarlinkMap.tsx`, `Bitchat.tsx`,
  `Settings.tsx`, `Login.tsx`

**Data:**
- `src/db/database.ts` — Dexie schema (8 migrations)
- `src/db/seedData.ts` — mock families, distributions, workers, kids
  content. Includes a one-shot `computeRuleScore` pass at seed time so
  seeded families have explicit `recommended_items`.

**Types:**
- `src/types/index.ts` — `Family`, `AidDistribution`, `Worker`,
  `KnowledgeDocument`, etc. Notable optional fields on `Family`:
  `deleted_at`, `deletion_reason`, `recommended_items`,
  `priority_score`, `priority_level`, `ai_reason`,
  `new_need_flagged`, `last_medical_notes`, `last_delivery_notes`.

**Stores (Zustand):**
- `src/stores/authStore.ts` — current user (PIN login state)
- `src/stores/settingsStore.ts` — theme, language, Ollama overrides
- `src/stores/connectivityStore.ts` — online / local / disconnected

**Locales:**
- `src/locales/{en,ar,fr,es}.json` — Arabic is RTL. Adding a new
  string means adding it to ALL FOUR — the QA suites check parity.

---

## 9. Useful Git incantations for this repo

```bash
# Survey state at start of session
git fetch origin --prune
git status --short
git branch --show-current
git log --oneline origin/main..HEAD   # local commits not on main
git log --oneline HEAD..origin/main   # remote commits not local
git branch -r                          # remote branches

# Standard PR workflow (direct push to main is BLOCKED)
git checkout main && git pull origin main
git checkout -b feature/<name>
# … work, stage with specific paths, commit …
git push -u origin feature/<name>
# → user merges PR via GitHub web UI
# → after merge:
git checkout main && git pull origin main
git push origin --delete feature/<name>
git branch -d feature/<name>

# Sanity check before pushing
npx tsc --noEmit -p tsconfig.json   # exit 0 = clean
npm run build                        # ✓ built in … = clean
node scripts/qa/test-duplicate-prevention.mjs  # all 84 should pass
node scripts/qa/test-import-no-autoseed.mjs    # all 28 should pass
node scripts/qa/test-family-delete.mjs         # all 137 should pass

# Live AI verification (needs Ollama running)
node scripts/qa/test-tool-calls.mjs            # function calling
node scripts/qa/test-paper-form-ingest.mjs     # multimodal vision
```

---

## 10. Things the next session should NOT do

- Don't push to `main` directly — it's blocked.
- Don't restore the old `aidflow-action` fenced-JSON protocol as the
  primary AI-edit path. Tool calling is canonical now.
- Don't add a rule-engine fallback for `recommended_items` in the UI.
- Don't add a non-AI feature row to the README's section-2 table.
- Don't auto-fill demographics, medical conditions, or items based on
  inference. Only the user enters real data.
- Don't bring back native `window.confirm` / `window.prompt` anywhere.
- Don't use `t('key') ?? 'default'`. Use `t('key', 'default')`.
- Don't add emoji to source files unless the user explicitly asks.
- **Don't add a "Synthesize whole library" button** or any other
  dedicated cross-document synthesis surface on the Knowledge Base
  page. The chat panel already does cross-document retrieval +
  synthesis via `retrieve()` (top-k chunks across all docs). The user
  explicitly removed a dedicated button. See Invariant 11.
- **Don't render `app.name` / `app.tagline` next to the logo image.**
  The logo already contains the "AIDFLOW" wordmark. See Invariant 12.
- Don't introduce new npm dependencies casually — the user trimmed 4
  unused ones (leaflet, react-leaflet, @types/leaflet, workbox-window).
- Don't commit `.tsbuildinfo`, `vite.config.js`, `vite.config.d.ts`,
  `.claude/settings.local.json`, or anything under `.claude/worktrees/`.
  All ignored by `.gitignore`.

---

## 11. Open questions / things the user might ask next

- "Help me record the demo video" — they'll need a shot list and
  probably a rough script.
- "Help me make a cover image" — composite of Dashboard + Family
  Detail + Apply/Discard. Suggest dimensions for Kaggle (typically
  1280×720 or similar).
- "Help me write the Kaggle Notebook" — mostly a copy of the README
  in Kaggle's format, with embedded screenshots. The Notebook is
  required for submission.
- "Should I trim the older `familyActions.ts` / `familyIntent.ts`?"
  — they were kept as fallback for non-tool-calling Gemma builds.
  Probably keep through hackathon, then re-evaluate.
- "How do I handle X bug?" — push back gently if it's edge-case. The
  6 days left are better spent on submission packaging. (Be honest:
  the previous session has been bug-fixing more than packaging.)

---

## 12. Tool / agent notes for the next session

- The harness exposes deferred tools via `ToolSearch` — load them
  with `select:<name>` before invoking.
- `ScheduleWakeup` is for `/loop` mode dynamic pacing.
- The dev server might still be running on `localhost:5173` from the
  previous session — check before assuming you need to start it.
- `Ollama` is reachable at `localhost:11434` and serves `gemma4:e4b`
  (and `gpt-oss:120b`, which is not used by this project). Don't
  assume it's running — `pingOllama()` is the production probe;
  `curl -sS http://localhost:11434/api/tags --max-time 3` works from
  Bash for a quick check.

Good luck. The user is sharp, decisive, and impatient with hedging. Be
specific, verify before you claim, and prioritize the hackathon
submission package over additional bug-fixing.
