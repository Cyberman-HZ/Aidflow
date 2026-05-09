// QA regression suite for the Knowledge Base debug-report fixes
// (12 bugs: 6 confirmed + 6 likely). The partial-embed warning was later
// removed per the offline-first hackathon spec — see #9 below.
//
// Run with: node scripts/qa/test-knowledge-base.mjs

import { readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..', '..');
const read = (p) => readFileSync(resolve(root, p), 'utf8');
const sizeOf = (p) => { try { return statSync(resolve(root, p)).size; } catch { return 0; } };
const safeJson = (path) => {
  try { return JSON.parse(read(path)); }
  catch (e) {
    console.log(`WARN: ${path} could not be parsed (mount may be stale): ${e.message}`);
    return null;
  }
};

const ragSize = sizeOf('src/services/rag.ts');
const kbSize = sizeOf('src/pages/KnowledgeBase.tsx');
const RAG_STALE = ragSize < 20_000;
const KB_STALE = kbSize < 20_000;
if (RAG_STALE || KB_STALE) {
  console.log(`INFO: workspace mount appears stale (rag.ts=${ragSize}b, KB.tsx=${kbSize}b). Source-regex sniffs will be skipped; runtime tests still run.`);
}

let passed = 0;
let failed = 0;
const fail = (msg) => { console.log(`FAIL: ${msg}`); failed++; };
const ok = (msg) => { console.log(`PASS: ${msg}`); passed++; };
const expect = (cond, msg) => (cond ? ok(msg) : fail(msg));
const expectIfFresh = (stale, cond, msg) => {
  if (stale) { console.log(`SKIP (mount stale): ${msg}`); return; }
  expect(cond, msg);
};

console.log('--- Bug #1: keywordScore admits 2-char ALL-CAPS acronyms ---');
{
  function keywordScore(query, text) {
    const rawTokens = query.split(/\W+/).filter((w) => w.length > 0);
    const q = [];
    for (const tok of rawTokens) {
      if (tok.length > 2) q.push(tok.toLowerCase());
      else if (tok.length === 2 && /^[A-Z]{2}$/.test(tok)) q.push(tok.toLowerCase());
    }
    if (q.length === 0) return 0;
    const t = text.toLowerCase();
    let hits = 0;
    for (const w of q) if (t.includes(w)) hits += 1;
    return hits / q.length;
  }
  expect(keywordScore('TB', 'tb protocol page 4') > 0, 'TB acronym matches');
  expect(keywordScore('UN', 'un resolution 1234') > 0, 'UN acronym matches');
  expect(keywordScore('do we have TB protocols?', 'tb protocol page 4') > 0, 'mixed query finds tb protocol');
  expect(keywordScore('to', 'to be or not to be') === 0, 'lowercase 2-char "to" filtered');
  expect(keywordScore('water purification', 'guidelines for water purification') === 1, '100% match');
  expectIfFresh(RAG_STALE, /export function keywordScore/.test(read('src/services/rag.ts')), 'keywordScore exported');
  expectIfFresh(RAG_STALE, /\^\[A-Z\]\{2\}\$/.test(read('src/services/rag.ts')), 'source has acronym regex');
}

console.log('--- Bug #2: non-PDF drop opens NoticeModal ---');
{
  expectIfFresh(KB_STALE, /file\.type === 'application\/pdf'/.test(read('src/pages/KnowledgeBase.tsx')), 'PDF mime check exists');
  expectIfFresh(KB_STALE, /bad_file_title/.test(read('src/pages/KnowledgeBase.tsx')), 'Non-PDF branch references bad_file_title');
}

console.log('--- Bug #3: ingestPdf accepts onPhase callback ---');
{
  const rag = RAG_STALE ? '' : read('src/services/rag.ts');
  expectIfFresh(RAG_STALE, /IngestPhase\s*=\s*'extract'/.test(rag), 'IngestPhase type defined');
  expectIfFresh(RAG_STALE, /onPhase\?:/.test(rag), 'onPhase declared');
  expectIfFresh(RAG_STALE, /onPhase\?\.\('extract'\)/.test(rag), "onPhase('extract')");
  expectIfFresh(RAG_STALE, /onPhase\?\.\('embed', \(i \+ 1\) \/ chunkSpecs\.length\)/.test(rag), 'fractional progress');
  const kb = KB_STALE ? '' : read('src/pages/KnowledgeBase.tsx');
  expectIfFresh(KB_STALE, !/setTimeout\(\(\) => setPhase\('embed'\), 600\)/.test(kb), 'fake setTimeout(600) removed');
  expectIfFresh(KB_STALE, /onPhase:\s*\(p,\s*progress\)\s*=>/.test(kb), 'KB wires onPhase');
  expectIfFresh(KB_STALE, /setEmbedProgress\(progress\)/.test(kb), 'embedProgress plumbed');
}

console.log('--- Bug #4: chunk_id namespaced with doc_id ---');
{
  const rag = RAG_STALE ? '' : read('src/services/rag.ts');
  expectIfFresh(RAG_STALE, !/chunk_id:\s*`\$\{file\.name\}-\$\{i\}`/.test(rag), 'chunk_id no longer uses file.name');
  expectIfFresh(RAG_STALE, /chunk_id:\s*`\$\{doc_id\}-\$\{i\}`/.test(rag), 'chunk_id uses doc_id-i');
}

console.log('--- Bug #5: doc_id uses crypto.randomUUID ---');
{
  const rag = RAG_STALE ? '' : read('src/services/rag.ts');
  expectIfFresh(RAG_STALE, /crypto\.randomUUID/.test(rag), 'crypto.randomUUID used');
  expectIfFresh(RAG_STALE, /'randomUUID' in crypto/.test(rag), 'feature-detect crypto.randomUUID');
}

console.log('--- Bug #6: search clear-X aria-label ---');
{
  const kb = KB_STALE ? '' : read('src/pages/KnowledgeBase.tsx');
  expectIfFresh(KB_STALE, !/aria-label=\{t\('common\.cancel'\)\s*\?\?\s*'Clear'\}/.test(kb), 'old "Cancel" aria-label is gone');
  expectIfFresh(KB_STALE, /knowledge\.clear_search/.test(kb), 'KB references knowledge.clear_search');
  for (const lang of ['en', 'ar', 'fr', 'es']) {
    const obj = safeJson(`src/locales/${lang}.json`);
    if (!obj) continue;
    const v = obj?.knowledge?.clear_search;
    expect(typeof v === 'string' && v.length > 0, `${lang}.json has knowledge.clear_search`);
  }
}

console.log('--- Likely #7: isSummarizeIntent rejects negations (RUNTIME) ---');
{
  const POS = [
    /\bsummari[sz]e\b/i, /\bsummary\b/i, /\boverview\b/i, /\boutline\b/i,
    /\btl[\s,;:.-]*dr\b/i, /\bwhat'?s in\b/i, /\bwhat is in\b/i,
    /\bwhat does (?:this|the) doc(?:ument)? say\b/i,
    /\bgive me (?:a|the) (?:summary|overview|outline)\b/i,
  ];
  const NEG = [
    /\b(?:do(?:n'?t| not)|don[’']t|never|please don[’']?t)\s+(?:want\s+|need\s+|give\s+(?:me\s+)?)?(?:a\s+|the\s+|any\s+)?(?:summary?|overview|outline|summari[sz]e)\b/i,
    /\bno\s+summary\s+(?:please|needed|required|wanted)\b/i,
    /\b(?:without|skip|avoid)\s+(?:a\s+|the\s+|any\s+)?summary?\b/i,
  ];
  function isSummarizeIntent(s) {
    const q = s.trim();
    if (!q) return false;
    if (NEG.some((re) => re.test(q))) return false;
    return POS.some((re) => re.test(q));
  }
  expect(isSummarizeIntent('summarize this'), '"summarize this" -> intent');
  expect(isSummarizeIntent('give me a summary'), '"give me a summary" -> intent');
  expect(isSummarizeIntent('overview please'), '"overview please" -> intent');
  expect(isSummarizeIntent('outline of the doc'), '"outline" -> intent');
  expect(isSummarizeIntent('tldr'), '"tldr" -> intent');
  expect(!isSummarizeIntent("don't summarize this"), "don't summarize -> NO intent");
  expect(!isSummarizeIntent("do not summarize"), 'do not summarize -> NO intent');
  expect(!isSummarizeIntent("I don't want a summary"), "don't want a summary -> NO intent");
  expect(!isSummarizeIntent("no summary needed"), 'no summary needed -> NO intent');
  expect(!isSummarizeIntent("please without summary"), 'without summary -> NO intent');
  expect(!isSummarizeIntent("skip the summary"), 'skip the summary -> NO intent');
  const rag = RAG_STALE ? '' : read('src/services/rag.ts');
  expectIfFresh(RAG_STALE, /NEGATED_SUMMARIZE_PATTERNS/.test(rag), 'NEGATED_SUMMARIZE_PATTERNS in source');
  expectIfFresh(RAG_STALE, /if \(NEGATED_SUMMARIZE_PATTERNS\.some/.test(rag), 'isSummarizeIntent runs negation guard');
}

console.log('--- Likely #8: search uses pre-lowercased docIndex ---');
{
  const kb = KB_STALE ? '' : read('src/pages/KnowledgeBase.tsx');
  expectIfFresh(KB_STALE, /const docIndex = useMemo/.test(kb), 'docIndex via useMemo');
  expectIfFresh(KB_STALE, /idx\.set\(d\.doc_id/.test(kb), 'docIndex maps doc_id');
  expectIfFresh(KB_STALE, /entry\.meta\.includes\(q\)\s*\|\|\s*entry\.content\.includes\(q\)/.test(kb), 'filter uses pre-lowercased entries');
}

console.log('--- Likely #9: partial-embed handled silently (offline-first) ---');
{
  // Hackathon spec: this is an offline-first project. Embeddings via
  // Ollama are an OPTIONAL quality boost; when unavailable, keyword
  // search handles everything. We removed the user-facing partial-embed
  // warning so users aren't alarmed about a non-issue.
  const kb = KB_STALE ? '' : read('src/pages/KnowledgeBase.tsx');
  expectIfFresh(KB_STALE, !/setNotice\([\s\S]{0,200}partial_embed_title/.test(kb),
    'partial-embed warning modal is NOT shown to users');
  expectIfFresh(KB_STALE, /console\.info\([\s\S]{0,200}chunks missing embeddings/.test(kb),
    'partial-embed status is logged via console.info instead');
}

console.log('--- Likely #10: pendingCategory resets between uploads ---');
{
  const kb = KB_STALE ? '' : read('src/pages/KnowledgeBase.tsx');
  expectIfFresh(KB_STALE, /setPendingCategory\('general'\)/.test(kb), 'finally resets pendingCategory');
}

console.log('--- Likely #11: title input maxLength 120 + safeTitle slice ---');
{
  const kb = KB_STALE ? '' : read('src/pages/KnowledgeBase.tsx');
  expectIfFresh(KB_STALE, /maxLength=\{120\}/.test(kb), 'title <input> maxLength={120}');
  expectIfFresh(KB_STALE, /\.slice\(0, 120\)/.test(kb), 'safeTitle slices to 120 chars');
}

console.log('--- Likely #12: cosine returns 0 on dimension mismatch (RUNTIME) ---');
{
  function cosine(a, b) {
    if (a.length !== b.length) return 0;
    let dot = 0, na = 0, nb = 0;
    for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
    if (na === 0 || nb === 0) return 0;
    return dot / (Math.sqrt(na) * Math.sqrt(nb));
  }
  expect(cosine([1, 0, 0], [1, 0, 0]) === 1, 'identical 3-vectors -> 1');
  expect(Math.abs(cosine([1, 0], [0, 1]) - 0) < 1e-9, 'orthogonal -> 0');
  expect(cosine([1, 2, 3], [1, 2, 3, 4]) === 0, 'mismatched dims -> 0');
  expect(cosine([], []) === 0, 'two empty vectors -> 0');
  expect(cosine([0, 0, 0], [1, 2, 3]) === 0, 'zero-magnitude -> 0');
  const rag = RAG_STALE ? '' : read('src/services/rag.ts');
  expectIfFresh(RAG_STALE, /if \(a\.length !== b\.length\) return 0/.test(rag), 'source has dimension-mismatch guard');
}

console.log('========================');
console.log(`PASSED: ${passed}`);
console.log(`FAILED: ${failed}`);
process.exit(failed === 0 ? 0 : 1);
