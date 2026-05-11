# AidFlow Pro — Claude Code briefing

This file is the entry point for Claude Code (or any new assistant) joining
this codebase. Read it before doing anything else. It captures the project's
purpose, the architecture, the rules of the road, and the load-bearing
decisions made so far.

---

## 1. What this is

AidFlow Pro is an **AI-powered humanitarian aid distribution Progressive Web
App**. Field workers use it to triage families, plan deliveries, run the
distribution lifecycle, and look up reference material — entirely offline
once the page has loaded once.

Built for the **Gemma 4 Good Hackathon**. The on-device model is
`gemma4:e4b` served via Ollama on `localhost:11434`. Two hard rules from
the project owner (`F:\Gemma 4 project\Humanitarian aid distribution AI`
project instructions):

1. **Hackathon-compliant** — work for the Gemma 4 Good Hackathon brief.
2. **Offline-first** — the app must keep working with no internet at all.
   Ollama can be reachable on the LAN. If even Ollama is unreachable, the
   app falls back to a deterministic rule engine — never blocks the user.

Three roles in the UI: admin, supervisor, field worker. Auth is a demo PIN
login backed by `aidflow-auth` in `localStorage`. **Hackathon posture
only — not production auth.** PINs are visible on the login screen and
stored plaintext in IndexedDB. Anyone with DevTools has the credential set.

---

## 2. Stack

- **Vite 5 + React 18 + TypeScript + TailwindCSS** (PWA via vite-plugin-pwa)
- **IndexedDB via Dexie.js** — single source of truth client-side
  (`src/db/database.ts`, schema v8 at last commit)
- **Ollama** — `gemma4:e4b` chat model + `nomic-embed-text` for RAG. All AI
  goes through `src/services/ollama.ts`. There is no remote AI fallback.
- **i18next** for EN / AR / FR / ES, with RTL handling for Arabic (see
  `src/i18n.ts` for `RTL_LANGS`)
- **PapaParse** for CSV, **SheetJS (`xlsx`)** lazy-loaded for XLSX in the
  Families spreadsheet-import wizard
- **PDF.js** for Knowledge-Base PDF ingestion
- **Leaflet / react-leaflet** for Starlink reseller list (no map ships in
  the active UI — list grouped by continent with hourly GitHub-raw sync)
- **Print-to-PDF** for all exports (Dashboard summary, KB summary,
  Emotional Support cards). **Zero PDF dependencies.** We open a popup,
  inject styled HTML, fire `window.print()`. Real selectable text,
  RTL-correct for Arabic.

Build with `npm run build`. Typecheck with `npx tsc --noEmit -p .`.

---

## 3. Top-level layout

```
src/
  App.tsx                 router shell, layout
  main.tsx                React bootstrap. Uses Promise.allSettled for
                          seed + cleanup so a seed failure can't blank
                          the screen.
  i18n.ts                 i18next setup + RTL_LANGS export
  index.css               Tailwind entry + a few prose-* helpers
  db/
    database.ts           Dexie schema (v8). Tables: families,
                          distributions, sessions, workers, kids,
                          knowledge_docs, knowledge_chunks, settings.
    seedData.ts           Demo data. Runs in main.tsx if DB is empty.
  pages/
    Dashboard.tsx         Mission overview + AI executive summary
    Families.tsx          List view, filters, sorts, soft-delete filter
    FamilyDetail.tsx      Inline-edit profile + chat (AIChat) + needs
    Distribute.tsx        Order lifecycle, dispatch wizard, history
    Workers.tsx           Field worker CRUD (soft-delete)
    Assistant.tsx         AidFlow Assistant (free-form chat over full
                          app snapshot + RAG)
    KnowledgeBase.tsx     Document library + map-reduce summarizer
    KidsContent.tsx       Emotional Support library (uploads + AI gen)
    StarlinkMap.tsx       Reseller list grouped by continent
    Bitchat.tsx           Install guide + offline APK storage
    Settings.tsx          Theme, language, Ollama config, embed model
    Login.tsx             PIN login (hackathon demo)
  components/             Shared UI. Notable:
    AIChat.tsx            Family AI chat + intent detector wiring
    FamilyEditModal.tsx   Add/Edit family. Hosts the inline CSV/XLSX
                          import wizard.
    EmotionalSupportGenModal.tsx  Streaming AI content generator
    StatusBadge.tsx       Distribution status + ALLOWED_TRANSITIONS
    ConnectivityBanner.tsx 3-state online/local/disconnected banner
  services/
    ollama.ts             pingOllama, chat, chatStream, embed,
                          prioritizeFamilies, recomputeAfterEdit.
                          AbortController is wired through withTimeout
                          so timeouts actually cancel the fetch.
    rag.ts                ingestPdf, retrieve, summarize (map-reduce
                          for long docs), cosine, keywordScore. Chunk
                          IDs are namespaced under a randomUUID doc_id.
    aiContext.ts          Builds the AppSnapshot block fed to Gemma.
                          dashboardBlock is the public entry point.
    familyIntent.ts       Deterministic intent detector — short-circuits
                          Gemma 4 for the common edit phrases.
    familyActions.ts      Parses fenced JSON action blocks from the AI
                          and validates them. stripFamilyActions only
                          strips the fenced blocks that actually parse,
                          so ```js examples survive intact.
    priorityRules.ts      Rule engine fallback when Ollama is down.
                          Math.max(0, days) handles clock skew.
    spreadsheetImport.ts  PapaParse + xlsx via dynamic import.
                          IMPORTABLE_FIELDS explicitly excludes
                          family_id (IDs are system-generated).
    orderNumber.ts        addDistributionWithNextOrderNumber — atomic
                          read+write in a Dexie 'rw' transaction.
    emotionalSupportGen.ts Streaming generator + utf8-safe base64
                          helpers used everywhere we round-trip text
                          through data URLs.
    nominatim.ts          Address resolution. Region fallback chain:
                          city → state → region → country.
    starlinkCountries.ts  Cached country availability list
    resellers.ts          Hourly sync from GitHub raw + Dexie cache
    bitchat.ts            APK metadata helpers
    webSearch.ts          Wikipedia-only search (offline-friendly)
  stores/                 Zustand stores
    authStore.ts          PIN session, persisted to localStorage
    settingsStore.ts      Theme, language, ollamaBaseUrl, ollamaModel,
                          embedModel
    connectivityStore.ts  3-state probe. HMR-safe: listeners + interval
                          are stashed on window and disposed via
                          import.meta.hot.dispose so dev edits don't
                          accumulate timers.
  locales/
    en.json ar.json fr.json es.json
  types/
    index.ts              All shared interfaces. Family has deleted_at.
                          Worker has deleted_at. DistributionStatus +
                          PriorityLevel are string unions.

scripts/
  qa/                     7 node test suites, no external deps. Each
                          exits non-zero on first failure. Run any one
                          with `node scripts/qa/<name>.mjs`.
  clean-source.mjs        Source hygiene helper.

public/
  icons/ logo.png         App icon (user-supplied logo wired in App)
```

---

## 4. Architecture decisions worth knowing

### 4a. Offline-first, three-state connectivity
- **online**   — real internet + Ollama reachable
- **local**    — no internet, Ollama reachable
- **disconnected** — Ollama unreachable, rule engine takes over

`navigator.onLine` alone is unreliable on Windows; we additionally probe
captive-portal endpoints. The connectivity store binds online/offline
event listeners + a 20-second probe `setInterval`, and disposes them via
`import.meta.hot.dispose` so Vite HMR doesn't accumulate timers.

### 4b. Soft-delete everywhere
Workers and families both use `deleted_at?: string` instead of hard-delete.
Historic `AidDistribution.family_id` and `assigned_to` references stay
coherent, so the audit trail and history grids never go orphan. Every
`db.families.toArray()` / `db.workers.toArray()` display surface filters
with `.filter((f) => !f.deleted_at)`. **Never call `.delete()` on these
tables.** AIChat is the documented exception — it sees deleted families
because historic distributions can still reference them.

### 4c. Atomic order numbers
`addDistributionWithNextOrderNumber` runs the max-scan + insert inside a
single Dexie `'rw'` transaction. There is intentionally no non-atomic
`nextOrderNumber()` helper — concurrent creators would collide.

### 4d. RAG identifiers
- `doc_id` = `D-${base36-timestamp}-${16-hex-randomUUID}` (~64 bits of
  entropy)
- `chunk_id` = `${doc_id}-${i}` — namespaced under the doc so two PDFs
  uploaded with the same filename can't collide

### 4e. AI streaming with idle timeout
`chatStream` uses an AbortController that's refreshed on every delta. A
hung Ollama gets aborted after 90 s of silence instead of spinning
forever. Non-stream `chat`, `pingOllama`, and `embed` go through
`withTimeout(fn(signal), ms)` which wires the signal through to the
fetch, so timeouts actually cancel the network request.

### 4f. Deterministic intent detector before Gemma 4
`familyIntent.ts` recognises common edit phrases ("add 5 bottles of
water", "mark as critical", "change sector to X") and applies them
directly, short-circuiting the LLM. `add_recommended_item` canonicalises
via `findItem` first so "5 bottles of water" merges with an existing
"drinking water" entry instead of creating a duplicate.

### 4g. Print-to-PDF, no PDF libraries
All exports (Dashboard exec summary, KB doc summaries, Emotional Support
cards) build a styled standalone HTML doc, open a popup, and call
`window.print()`. The OS "Save as PDF" destination handles the rest.
Same approach everywhere; if you add a new export, copy the pattern in
`src/pages/KidsContent.tsx` `buildItemPrintDoc()`.

### 4h. UTF-8-safe data URLs
`utf8ToBase64` / `base64ToUtf8` / `decodeDataUrlText` in
`emotionalSupportGen.ts`. Use these whenever you round-trip Arabic /
French / Spanish through a data URL. `btoa` alone breaks on multi-byte
characters.

### 4i. Spreadsheet import lives inline
The CSV/XLSX import wizard is **inside** `FamilyEditModal` ("Add family →
Import spreadsheet → review each row inline"). The legacy
`SpreadsheetImportModal.tsx` is a stub kept only because this sandbox
can't delete files. Don't add new consumers of that file.

### 4j. Trauma-informed content
`EmotionalSupportGenModal` + `emotionalSupportGen.ts` follow a
trauma-informed rubric in the system prompt. Age brackets are
`5-7 | 8-11 | 12-15`. Stories, breathing exercises, journaling prompts,
games. "Coloring page" generation was intentionally dropped because the
text model can't draw.

### 4k. i18n is the source of truth for UI copy
All user-facing strings go through `t('namespace.key')`. The four locale
files must stay in parity — there's a parity sniff in
`scripts/qa/test-spreadsheet-import.mjs` and equivalents in the other
suites. Arabic locale drives RTL via `dir="rtl"` on the `<html>` root.

### 4l. Hackathon auth posture
`Login.tsx` plain string-equals the PIN, no rate limit, no lockout.
`authStore` persists to localStorage. Acceptable for the documented
demo; **not for production**. Don't expand on this without a real auth
provider plan.

---

## 5. Conventions

### File modifications
- **TypeScript** strict; `npx tsc --noEmit -p .` must be clean before
  shipping.
- **No emojis in source files** unless the user explicitly asks.
- **No new top-level `.md` files** unless asked.
- Prefer editing files in place; new files only when there's no natural
  home.
- Tailwind utility classes — no custom CSS unless absolutely required
  (look at `index.css` for the few prose-* helpers that exist).

### Branding
- Brand teal: `#00ADB5` (CSS class `brand`, `brand-dark`)
- Dark navy surfaces: `#222831` (`surface`, `surface-deep`,
  `surface-light`)
- AI accent: violet (`bg-ai`, `text-ai`)
- Priority levels: `priority-critical | priority-high |
  priority-medium | priority-normal`

### Gemma trademark
Per Google's brand guidelines, the Login page footer carries:
> "Gemma is a trademark of Google LLC. AidFlow Pro is not affiliated
> with or endorsed by Google."

UI labels that used to say "Gemma" now say "AidFlow" (the brand) or
"AidFlow Assistant" — Gemma is only referenced in attributions, never as
the product name.

### Translation keys
The user pinged a few times about hardcoded English creeping in. Every
new string you add: `t('namespace.your_key', 'English fallback')` AND
mirror it into all four locale files. The QA suites grep for known keys
across all four files.

---

## 6. QA scripts

There's no Vitest / Jest. Seven node-only suites in `scripts/qa/`. Each
imports nothing from the app source — they re-implement minimal versions
of the rules they're checking, then assert against text invariants of
the source files. Run them after any non-trivial change:

```
node scripts/qa/test-distribute.mjs              # 55 tests
node scripts/qa/test-emotional-support.mjs       # 46 tests
node scripts/qa/test-families-fixes.mjs          # 67 tests
node scripts/qa/test-family-profile-fixes.mjs    # 30 tests
node scripts/qa/test-family-profile.mjs          # 44 tests
node scripts/qa/test-knowledge-base.mjs          # 53 tests
node scripts/qa/test-spreadsheet-import.mjs      # 74 tests
```

Total at last green run: **369 tests, 0 failures.**

---

## 7. Known open audit items (not yet fixed)

Logged here so the next assistant doesn't re-discover them. From the
last `cf2de9a`-era audit:

- **FamilyEditModal duplicate `newFamilyId()` call** — `existing?.family_id ?? newFamilyId()` is computed alongside a spread that also synthesises an id. The duplicate id is harmless (only one survives) but the code is misleading.
- **KB upload phase indicator desync** — fake `setTimeout` in
  `KnowledgeBase.tsx` runs independent of the real ingest phases. Replace
  with the `onPhase` callback already wired in `rag.ts`.
- **KB drag-drop non-PDF silently ignored** — no error toast when the
  user drops e.g. a .docx.
- **Worker delete doesn't block pending assignments** — soft-deleting a
  worker with `out_for_delivery` orders leaves those orders orphaned in
  the UI.
- **`newWorkerId()` low entropy** — ~30 bits, same fix pattern as the
  rag.ts doc_id should apply (`crypto.randomUUID` slice).
- **AIChat stale `systemPrompt`** — captured at render time instead of
  at send time in one of the family-detail call paths. The Assistant
  page is already fixed.
- **`prioritizeFamilies` swallows JSON parse failures** — falls back to
  the rule engine without surfacing that Ollama errored. P2.
- **`validateFamilyAction` coerces `Number("1e308")` (Infinity) → 1** —
  silent rather than rejected. P2.
- **`EmotionalSupportGenModal` scroll-lock recovery** — if the stream
  errors but `streaming=true` is left set, in-app dismissal can leave
  the body lock on. P2.
- **`KidsContent.tsx` FileReader not cancelled on unmount** — large
  uploads can fire `db.kids.add()` after navigation away. P2.
- **`xlsx@^0.18.5` CVEs** — GHSA-4r6h-8v6p-xvw6 (prototype pollution),
  GHSA-5pgg-2g60-mcwc (ReDoS). SheetJS moved off npm; fixed builds are
  at `xlsx@0.20.x` via their CDN only. Migrating off npm is a separate
  PR (lockfile + bundling strategy change).
- **Bundle size warning** — main chunk ~1.78 MB / 517 kB gzipped. No
  `manualChunks` configured. PWA precache is ~2.4 MB. Worth a tracking
  issue but not blocking.

---

## 8. Working-with-this-project rules

From the project owner's CLAUDE-mode instructions:

> - Act as humanitarian aid distribution expert and disaster/crisis
>   recovery expert manager & planner.
> - Act as a web developer team of seniors.
> - When there are multiple options, **ask** rather than assume.
> - **Never assume** — research from official sources, and if you don't
>   know, ask.
> - The app/project must work **offline**.
> - It must comply with the Gemma 4 Good Hackathon brief.

Practical implications:
- If you're about to add a runtime dependency on something other than
  the user's Ollama + their browser, pause and ask first.
- If you find yourself reaching for a CDN at runtime (not at bundle
  time), pause and ask first — offline-first.
- If you're about to change Gemma to a different model identifier, ask.

---

## 9. Bash mount caveat (sandbox-specific)

When working from a Cowork-style sandbox where the bash environment is
mounted separately from the Windows filesystem, file edits via the
Read/Edit/Write tools occasionally take a few seconds to propagate to
the bash mount. If `npx tsc` reports errors in lines that look fine via
the Read tool, run `wc -l <file>` in bash to confirm the on-disk length
matches what Read shows. The fix is to rewrite the file through bash
(heredoc or python) so both views resync. This is purely a sandbox
quirk — it does not affect the actual Windows files the user runs the
app from.

---

## 10. Where to start

Most user requests fall into one of these buckets:

| Request                              | Start here                                              |
| ------------------------------------ | ------------------------------------------------------- |
| Add a feature to a tab               | The page file in `src/pages/`                           |
| Tweak the AI / prompt                | `src/services/ollama.ts` or `aiContext.ts`              |
| Add a string                         | The page + all 4 locale files in `src/locales/`         |
| Fix a bug from a report              | Grep the report's file paths first — line numbers drift |
| Add a new table or schema migration  | `src/db/database.ts` — bump the version                 |
| New AI-generated content surface     | Copy the `emotionalSupportGen.ts` streaming pattern     |
| Anything touching distribution flow  | Re-read `Distribute.tsx` and the QA suite               |

When in doubt: read the existing pattern in the area before introducing
a new one. The codebase is small enough to read end-to-end in an
afternoon.
