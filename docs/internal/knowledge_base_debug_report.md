# Knowledge Base Tab Debug Report

Generated 2026-05-09 from a read-only review of `src/pages/KnowledgeBase.tsx` (~770 lines after the recent rewrite), `src/services/rag.ts` (~700 lines), `src/components/AIChat.tsx`, `src/types/index.ts`, `src/db/database.ts`, and `src/locales/{en,ar,fr,es}.json` `knowledge.*` blocks.

This page was rewritten in the same conversation and now hosts: a single Documents section, a search bar, per-row Summarize buttons with inline streaming, in-app NoticeModal + DeleteDocumentModal (replacing browser `alert`/`confirm`), and a `forceRag`-locked AIChat panel.

## Pre-flight

- `node scripts/qa/test-family-profile.mjs` -> PASSED 44 / FAILED 0.
- `node scripts/qa/test-family-profile-fixes.mjs` -> PASSED 30 / FAILED 0.
- `node scripts/qa/test-distribute.mjs` -> PASSED 55 / FAILED 0.
- No KB-specific suite exists (`scripts/qa/test-knowledge-base.mjs` is absent).
- Locale parity for the new `knowledge.*` keys is OK in en/ar/fr/es (all four have the new `scanned_*`, `delete_*`, `summary_*`, `match_*`, `library`, `upload_*`, `ai_summary`, `summarize`, `summarizing`, `search_placeholder`, `no_matches*` keys).

## Reproduction summary

| User flow | Code path | Expected | Actual |
|---|---|---|---|
| Page load | `KnowledgeBase.tsx:40` `useLiveQuery(db.documents.toArray())` | Library renders reactively | OK |
| Drag-drop a PDF | `KnowledgeBase.tsx:188-191` `onDrop` checks `file.type === 'application/pdf'` | PDF accepted; non-PDF dropped silently | **Non-PDF drops silently fail with no user feedback** |
| Click dropzone after a file is staged | `onClick={() => fileInput.current?.click()}` on the dotted div | Click reopens the file picker so the user can swap files | OK; but the pending-file panel below is rendered inside the same `<Card>` and clicking it does NOT bubble to the dropzone (panel has its own click targets). OK. |
| Empty title submit | `pendingTitle.trim() \|\| pendingFile.name` | Falls back to filename | OK |
| Long-running embed phase | `setTimeout(() => setPhase('embed'), 600)` then `await ingest`; then `setPhase('save')` | Progress bar advances in step | **Phase state machine has fake setTimeouts that can desync** |
| Upload of scanned PDF | `KnowledgeBase.tsx:211-220` post-ingest 0-chunk check | NoticeModal opens with warning copy | OK |
| Upload of corrupt PDF | `try/catch` around `ingestPdf` | Error notice modal | OK |
| Library search "TB" | `Families.tsx`-style trim+lowercase + `chunks.some(c => c.text.toLowerCase().includes(q))` | Matches a doc that mentions "TB" | **OK in the LIBRARY filter, but BROKEN in RAG keyword fallback** (see #5) |
| Search clear-X | `setSearch('')` | Clears query, focus stays in input | OK; aria-label uses `common.cancel` ("Cancel") which is semantically wrong |
| Summarize a 0-chunk doc | Button `disabled={!d.chunks \|\| d.chunks.length === 0}` | Click is no-op; tooltip explains | OK |
| Summarize a normal doc | `summarizeDocumentStream(doc.doc_id, language)` | Streams markdown into inline panel | OK |
| Delete during summary stream | `performDelete` checks `summary?.docId === confirmDelete.doc_id` and clears | Inline panel closes cleanly | OK |
| Delete a doc | `db.documents.delete(doc.doc_id)` | Hard delete | OK; modal a11y intact |
| AIChat `forceRag` | `useState(forceRag)` initial; `disabled={forceRag}` | Checkbox locked on; first send hits RAG | OK |
| RAG with "do we have a doc about TB?" (offline mode) | `keywordScore` with `.filter((w) => w.length > 2)` | Should match | **`TB` (2 chars) is dropped from the query, score = 0** |

## Findings

### CONFIRMED bugs

1. **`rag.ts:95` — `keywordScore` drops words ≤2 chars; humanitarian acronyms collapse to score 0.**
   Code: `const q = query.toLowerCase().split(/\W+/).filter((w) => w.length > 2);`
   In offline mode (Ollama down) we fall back to keyword scoring. Humanitarian work is full of 2-char abbreviations: **TB** (tuberculosis), **HE** (head of household), **HH** (household), **PV** (per-visit), country codes (**EU**, **AR**), etc. A query like *"do we have TB protocols?"* tokenises to `["do", "have", "protocols"]` (TB removed). The `protocols` token won't be in a doc that uses the word "tuberculosis" verbatim, so `score = 0` everywhere → empty branch fires → "No matching content found" — even when the doc literally has `TB protocols` in its title. Recommended fix: lower the threshold to `length >= 2`, OR treat an uppercase 2-char token as a meaningful acronym (`/^[A-Z]{2,}$/.test(originalToken)`).

2. **`KnowledgeBase.tsx:188-191` — non-PDF drag-drop is silently ignored.**
   Code: `if (file && file.type === 'application/pdf') onPick(file);`. When a user drops a `.docx` or `.png`, nothing happens — no toast, no notice modal, the dropzone doesn't even visually flash. Users will think the dropzone is broken. Recommended fix: in the `else` branch, call `setNotice({ kind: 'warning', title: t('knowledge.bad_file_title'), body: t('knowledge.bad_file_body') })` so the rejection is visible. (Uses the NoticeModal we already built.)

3. **`KnowledgeBase.tsx:203,205-206` — phase indicator desyncs from real ingest progress.**
   ```
   const promise = ingestPdf(...);
   setTimeout(() => setPhase('embed'), 600);
   const doc = await promise;
   setPhase('save');
   await new Promise(r => setTimeout(r, 200));
   ```
   The 600 ms `embed` timer fires whether or not extraction has finished. On a fast PDF (Ollama offline → no embeddings), the real work completes in <200 ms so `setPhase('save')` runs first; then the queued `embed` timer fires AFTER, which makes the progress bar **jump backward from 100 % to 66 %**. On a slow embed (50-page PDF) the bar sits at 33 % silently for 30+ seconds, then snaps to 66 % at exactly the 600 ms mark — disconnected from reality. Recommended fix: thread real progress callbacks through `ingestPdf` (pass an `onPhase: (p) => void` option) and remove the timers entirely. As a quick stopgap, clear the `embed` timer in the post-ingest path: `const t = setTimeout(...); await promise; clearTimeout(t);`.

4. **`rag.ts:191` — chunk_id collisions when two PDFs share a filename.**
   Code: `chunk_id: \`${file.name}-${i}\`,`. If a user uploads `report.pdf`, then uploads a different `report.pdf` later (e.g. updated version), the second upload generates the same chunk_ids as the first. Chunks live inside the doc record so this isn't a Dexie key collision, but: (a) any code that joins by chunk_id across docs sees overlap; (b) citation strings include the chunk_id so users see duplicates in logs. Recommended fix: namespace chunk_ids with the doc_id: `chunk_id: \`${doc_id}-${i}\`,` (must be moved below the `doc_id` mint at line 207).

5. **`rag.ts:207` — doc_id has only ~30 bits of entropy; bulk-import collisions possible.**
   Code: `\`D-${Date.now()}-${Math.random().toString(36).slice(2, 8)}\``. 6 random base-36 chars ≈ 30 bits. Two PDFs ingested in the same millisecond have a non-trivial collision chance (this is exactly the workers bug we already fixed). Recommended fix: use `crypto.randomUUID()` when available (`typeof crypto !== 'undefined' && 'randomUUID' in crypto`), fall back to a wider random suffix. Same pattern as `newWorkerId()` after the workers hardening.

6. **`KnowledgeBase.tsx` search clear-X — aria-label is "Cancel" instead of "Clear search".**
   Code: `aria-label={t('common.cancel') ?? 'Clear'}`. Screen readers announce "Cancel" which is semantically wrong for a clear-text-input button. Recommended fix: add a dedicated `knowledge.clear_search` locale key and reference it; use `t('knowledge.clear_search') ?? 'Clear search'`.

### LIKELY bugs

7. **`rag.ts:272-282` — `isSummarizeIntent` false-positives on negations.**
   The pattern `/\bsummari[sz]e\b/i` matches "don't summarize", "I don't want a summary", "no summary please". Each of those would route to full-doc summary mode instead of standard RAG. Recommended fix: a quick-check `if (/\b(?:don'?t|do not|no|never)\s+(?:want\s+|need\s+)?(?:a\s+)?summary?(?:\s+|$)/i.test(s)) return false;` at the top of the function.

8. **`KnowledgeBase.tsx:165,178` — search runs O(N×M) chunk-text scan on every keystroke.**
   `d.chunks.some(c => c.text.toLowerCase().includes(q))` plus `c.text.toLowerCase()` allocates a fresh string each time. For 100 PDFs × 30 chunks, that's 3 000 fresh string allocations + substring searches per keystroke, debounced by React only via the natural input cadence. Recommended fix: pre-compute a flattened `lowercaseFullText` per doc once and cache it (in a `useMemo` keyed on docs), so each keystroke does only N substring tests over pre-lowercased buffers.

9. **`KnowledgeBase.tsx:196-237` — upload error path leaves partial state if `ingestPdf` saves the row before throwing.**
   `ingestPdf` does the embed loop *then* `db.documents.put`. If `embed` fails on chunk 17 of 50, we still ingest the partially-embedded chunks. `try/catch` shows the error notice but the row is already in IndexedDB (or the entire ingest threw before save — depends on where in the loop). Behavior is ambiguous. Recommended fix: wrap the whole ingest in a Dexie transaction so a partial failure rolls back; surface "ingest failed; document not saved" cleanly.

10. **`KnowledgeBase.tsx:175` — pending category isn't reset between uploads.**
    `setPendingFile(null)` and `setPendingTitle('')` clear; `pendingCategory` stays. Probably intended (user picks "medical" once, uploads 5 medical PDFs in a row), but worth confirming. If unintended, add `setPendingCategory('general')` in the `finally` block.

11. **`KnowledgeBase.tsx` title input — no max-length cap.**
    A 5 000-char paste lands in `db.documents.put` and then in every RAG inventory line, blowing past Gemma 4's context. Same hardening pattern as workers. Recommended fix: `maxLength={120}` on the title input + slice at save time.

12. **`rag.ts:85-91` — `cosine` doesn't normalise vector lengths.**
    Standard cosine returns dot / (|a| × |b|), which the code does. But if two embeddings have different dimensions (e.g. nomic-embed-text returns 768, but a legacy doc was ingested with a 384-dim model), the loop runs `i < a.length && i < b.length` and silently truncates — producing a meaningless score. Recommended fix: assert `a.length === b.length` and skip / re-embed mismatched chunks.

### NEEDS REPRO

13. **Modal trigger after rapid double-click on the trash icon.**
    `remove(doc)` is sync, opens the modal. A fast double-click could open the modal and immediately fire the same modal again (no-op since state replaces) — but if the user has Reduced Motion settings, the focus management may glitch. Manual repro on macOS / Windows.

14. **Summarize stream with Ollama disconnecting mid-stream.**
    `summarizeDocumentStream` yields deltas from `chatStream`. If the network drops mid-stream, the underlying fetch errors silently. The `try/catch` around the stream sets `summary.error` but the `done` event never fires, so the truncation warning never displays even if the partial output was incomplete. Manual repro: kill Ollama at exactly the right moment.

15. **Concurrent summarize + delete with `summaryBusy.current` guard.**
    `summaryBusy.current = true` prevents a SECOND summary from starting, but a DELETE during summary correctly closes the panel via `setSummary(null)`. However the still-in-flight `summarizeDocumentStream` async generator continues yielding to `setSummary` callbacks that no-op (they check `s && s.docId === doc.doc_id` against null state). No leak, but consumes Gemma 4 cycles for nothing. Manual repro: start summary, immediately delete the doc.

16. **RTL layout of the inline summary panel.**
    The summary panel uses `border-l-...`-style classes from `prose-ai` styles and the close button in the top-right uses `<XIcon />` without a logical position. Worth a visual check in `dir=rtl` (Arabic).

## Side-effect / cross-feature concerns

- **Aid Guides removal:** the `db.guides` table is still seeded and feeds `services/aiContext.ts` for the global Assistant. The KB UI no longer manages them, so the user has no way to add/edit aid-guide entries — only the seeded ones. Acceptable for the hackathon (per user request), but worth a follow-up: either expose guides as PDFs (auto-convert) or add a separate guides editor.
- **`prepareRagPrompt` inventory rebuild on every prompt:** lines 587-600 rebuild the inventory string on every chat message. For 100 docs with 50-char titles that's ~5 KB of string per prompt — acceptable but could be memoized with a Dexie change subscription.
- **`forceRag` doesn't react to runtime prop changes.** `useState(forceRag)` only reads on mount. If a parent ever toggles `forceRag` after mount, the checkbox state diverges. Today no parent does that, but worth a `useEffect(() => setUseRag(forceRag), [forceRag])` for defensiveness.
- **PDF-to-doc duplicate guard:** there's no check for "you already uploaded this exact PDF" — by content hash or title+filename. Same workers-style soft duplicate guard would help.
- **RAG `relevanceFloor` thresholds are not user-tunable.** 0.4 cosine / 0.25 keyword may be too strict or too loose for some org's docs. No setting in Settings.

## Missing test coverage

- No `scripts/qa/test-knowledge-base.mjs`. Suggested unit tests:
  1. `keywordScore` handles 2-char acronyms (after fix #1).
  2. `isSummarizeIntent` rejects negated forms (after fix #7).
  3. `chunkPages` handles empty pages, single-line pages, very long single-page docs.
  4. `buildFullDocText` treats whitespace-only pages as empty (already covered by behavior — assert the contract).
  5. `findReferencedDocument` longest-match wins, case-insensitive, ignores titles <3 chars.
  6. `prepareRagPrompt` low-confidence inventory hint is included verbatim; high-confidence path omits the warning.
  7. `summarizeDocumentStream` short-circuits to "no extractable text" branch when `usableChars < MIN_USABLE_CHARS`.
- No accessibility test for the new modals (Escape, focus, scroll lock). Same gap as Workers.
- No integration test for the upload pipeline → search → summarize → delete flow.

## Prevention recommendations

1. **Promote progress callbacks in `ingestPdf`.** Replace the fake setTimeouts with a real progress hook (`onPhase: (phase, percent) => void`). This is the source of most "the upload UI feels broken" reports.
2. **Centralise text-input length caps + duplicate detection.** Workers, Families, and KB have all needed the same hardening. Extract `<TextInput maxLength={...}>` and a `softDuplicateGuard(table, predicate)` helper into `src/components/forms/`.
3. **Add an i18n parity CI gate** (recommended in earlier reports too). Walk every leaf key in en.json and assert presence in ar/fr/es. Block CI on missing keys; warn on values equal to EN for non-proper-noun strings.
4. **Add a chunk text-search index** (lowercase pre-computed buffer per doc) so library search stays sub-100ms at 1000+ docs. Same pattern would also benefit the families search.
5. **Use `crypto.randomUUID()` for all entity ids** (workers were fixed; docs/chunks are next). Centralise in `src/services/ids.ts`.
6. **Add a content-hash dedupe check at upload time.** SHA-256 of the PDF buffer, compared against existing docs' hashes (new field `content_hash` on KnowledgeDocument). Soft-warn on duplicate, soft-merge if user confirms.

## Top 3 to fix before submitting (P0)

1. **#1** — keyword-fallback drops 2-char acronyms (`TB`, `HE`, `HH`). High user impact when offline.
2. **#3** — phase indicator desync. Cosmetic but very visible — users notice the bar jumping backward.
3. **#2** — non-PDF drag-drop silently fails. UX trap; users think the page is broken.

## Top 3 hardening (P1)

4. **#4 + #5** — chunk_id / doc_id collision risks. Low probability today, but when bulk-import lands these become real.
5. **#7** — negation false-positives in summarize-intent.
6. **#9** — partial-ingest rollback (Dexie transaction).
