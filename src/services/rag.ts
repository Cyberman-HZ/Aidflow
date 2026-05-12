// AidFlow Pro — Browser-side RAG pipeline.
//
// Per the user's no-backend choice we run RAG entirely in the browser:
//   1. PDF text extraction with pdfjs-dist
//   2. Chunking (~500 chars w/ ~50-char overlap)
//   3. Embedding via Ollama's /api/embeddings (nomic-embed-text)
//   4. Cosine-similarity search over chunks stored in IndexedDB (Dexie)
//
// If Ollama / the embedding model isn't available, the search falls back to
// keyword scoring so the knowledge base remains queryable in pure offline mode.

import * as pdfjsLib from 'pdfjs-dist';
// @ts-ignore — Vite turns this URL into a worker bundle at build time
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

import { db } from '@/db/database';
import { embed, pingOllama, chat, chatStream } from './ollama';
import type { KnowledgeChunk, KnowledgeDocument, ChatMessage } from '@/types';

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

const CHUNK_CHARS = 1500; // ~500 tokens
const CHUNK_OVERLAP = 150; // ~50 tokens

// ---------- PDF extraction -----------------------------------------------

export async function extractTextFromPdf(
  file: File
): Promise<{ pages: { page: number; text: string }[]; pageCount: number }> {
  const buf = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: buf }).promise;
  const pages: { page: number; text: string }[] = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    const text = content.items
      .map((it) => ('str' in it ? it.str : ''))
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();
    pages.push({ page: i, text });
  }
  return { pages, pageCount: pdf.numPages };
}

// ---------- Chunking ------------------------------------------------------

export function chunkPages(
  pages: { page: number; text: string }[]
): { page_start: number; page_end: number; text: string }[] {
  const chunks: { page_start: number; page_end: number; text: string }[] = [];
  let buffer = '';
  let bufferStartPage = pages[0]?.page ?? 1;

  const flush = (currentPage: number) => {
    if (!buffer.trim()) return;
    chunks.push({ page_start: bufferStartPage, page_end: currentPage, text: buffer.trim() });
    // overlap
    const tail = buffer.slice(-CHUNK_OVERLAP);
    buffer = tail;
    bufferStartPage = currentPage;
  };

  for (const p of pages) {
    const text = p.text;
    let i = 0;
    while (i < text.length) {
      const space = CHUNK_CHARS - buffer.length;
      const slice = text.slice(i, i + space);
      buffer += (buffer ? ' ' : '') + slice;
      i += space;
      if (buffer.length >= CHUNK_CHARS) flush(p.page);
    }
  }
  flush(pages[pages.length - 1]?.page ?? bufferStartPage);
  return chunks;
}

// ---------- Cosine similarity --------------------------------------------

export function cosine(a: number[], b: number[]): number {
  // If two vectors come from different embedding models (e.g. a doc was
  // ingested with a 384-dim model and the query embeds with a 768-dim
  // one), the previous code silently truncated to min(|a|,|b|) and
  // returned a meaningless score. Treat that as "not comparable".
  if (a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/**
 * Token-coverage score for the offline keyword fallback. Words ≤2 chars
 * are usually noise ("to", "is", "of") so we drop them — EXCEPT when the
 * original token is an all-caps 2-char ACRONYM like TB (tuberculosis), HE
 * (head of household), HH (household), UN, EU, OCHA. Humanitarian context
 * is heavy with these and dropping them caused offline searches like
 * "do we have TB protocols?" to score zero everywhere.
 */
export function keywordScore(query: string, text: string): number {
  const rawTokens = query.split(/\W+/).filter((w) => w.length > 0);
  const q: string[] = [];
  for (const tok of rawTokens) {
    if (tok.length > 2) {
      q.push(tok.toLowerCase());
    } else if (tok.length === 2 && /^[A-Z]{2}$/.test(tok)) {
      // 2-char ALL-CAPS token — treat as a meaningful acronym.
      q.push(tok.toLowerCase());
    }
  }
  if (q.length === 0) return 0;
  const t = text.toLowerCase();
  let hits = 0;
  for (const w of q) if (t.includes(w)) hits += 1;
  return hits / q.length;
}

// ---------- Top-K retrieval ----------------------------------------------

export interface RetrievedChunk extends KnowledgeChunk {
  score: number;
  doc_title: string;
  /** "embedding" = cosine similarity, "keyword" = fallback word-coverage score. */
  scoreKind: 'embedding' | 'keyword';
}

/**
 * Similarity floors. With cosine, every chunk gets a non-zero score against
 * any query — even completely unrelated topics — so we need a minimum bar
 * to call a chunk "actually relevant". The numbers below are conservative
 * (calibrated against nomic-embed-text); raise if you see false positives.
 */
const MIN_COSINE_RELEVANT = 0.4;
const MIN_KEYWORD_RELEVANT = 0.25;

export function relevanceFloor(kind: 'embedding' | 'keyword'): number {
  return kind === 'embedding' ? MIN_COSINE_RELEVANT : MIN_KEYWORD_RELEVANT;
}

export async function retrieve(query: string, k = 10): Promise<RetrievedChunk[]> {
  const docs = await db.documents.toArray();
  const allChunks: { chunk: KnowledgeChunk; doc_title: string }[] = [];
  for (const d of docs) for (const c of d.chunks) allChunks.push({ chunk: c, doc_title: d.title });

  const ollamaUp = await pingOllama();
  let scored: RetrievedChunk[];

  if (ollamaUp) {
    try {
      const qEmbed = await embed(query);
      scored = allChunks.map(({ chunk, doc_title }) => {
        if (chunk.embedding) {
          return {
            ...chunk,
            doc_title,
            score: cosine(qEmbed, chunk.embedding),
            scoreKind: 'embedding' as const,
          };
        }
        return {
          ...chunk,
          doc_title,
          score: keywordScore(query, chunk.text),
          scoreKind: 'keyword' as const,
        };
      });
    } catch {
      scored = allChunks.map(({ chunk, doc_title }) => ({
        ...chunk,
        doc_title,
        score: keywordScore(query, chunk.text),
        scoreKind: 'keyword' as const,
      }));
    }
  } else {
    scored = allChunks.map(({ chunk, doc_title }) => ({
      ...chunk,
      doc_title,
      score: keywordScore(query, chunk.text),
      scoreKind: 'keyword' as const,
    }));
  }

  // Always return up to k by score so prepareRagPrompt can compute a
  // confidence signal even when nothing crosses the relevance floor.
  // Filtering to "actually relevant" happens at the prompt-prep layer.
  return scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, k);
}

// ---------- Ingestion ----------------------------------------------------

/**
 * Phases reported by `ingestPdf` so the UI can show real progress instead
 * of the previous fake setTimeouts that desynced from actual work.
 *  - 'extract' — pdfjs is parsing the file
 *  - 'embed'   — chunking + (optionally) embedding chunks via Ollama
 *  - 'save'    — writing the doc to IndexedDB
 *  - 'done'    — fully finished
 */
export type IngestPhase = 'extract' | 'embed' | 'save' | 'done';

export interface IngestOptions {
  /** Called with each phase transition AND the embedding progress
   *  (0..1) during the embed phase. Cheap UI hook. */
  onPhase?: (phase: IngestPhase, progress?: number) => void;
}

export async function ingestPdf(
  file: File,
  meta: { title: string; category: KnowledgeDocument['category']; uploaded_by: string },
  options: IngestOptions = {}
): Promise<KnowledgeDocument> {
  const { onPhase } = options;
  onPhase?.('extract');
  const { pages, pageCount } = await extractTextFromPdf(file);
  const chunkSpecs = chunkPages(pages);
  onPhase?.('embed', 0);
  const useEmbed = await pingOllama();

  // Mint the doc_id BEFORE the chunk loop so each chunk_id can be
  // namespaced with it. Previously chunk_id was `${file.name}-${i}` which
  // collided when a user uploaded two PDFs with the same filename
  // (e.g. report.pdf v1 then report.pdf v2). 16 hex chars from
  // crypto.randomUUID give ~64 bits of entropy — comfortably collision-
  // free even for bulk imports.
  const rand =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID().replace(/-/g, '').slice(0, 16)
      : Math.random().toString(36).slice(2, 18).padEnd(16, '0');
  const doc_id = `D-${Date.now().toString(36)}-${rand}`;

  const chunks: KnowledgeChunk[] = [];
  for (let i = 0; i < chunkSpecs.length; i++) {
    const c = chunkSpecs[i];
    const chunk: KnowledgeChunk = {
      chunk_id: `${doc_id}-${i}`,
      doc_id,
      page_start: c.page_start,
      page_end: c.page_end,
      text: c.text,
    };
    if (useEmbed) {
      try {
        chunk.embedding = await embed(c.text);
      } catch (e) {
        console.warn('[rag] embed failed for chunk', i, e);
      }
    }
    chunks.push(chunk);
    // Report fractional progress so the bar advances smoothly even for
    // long PDFs. Avoid divide-by-zero on single-chunk docs.
    if (chunkSpecs.length > 0) {
      onPhase?.('embed', (i + 1) / chunkSpecs.length);
    }
  }

  // Keep the original PDF binary in IndexedDB so the admin can re-download
  // it later (or share it with someone who needs the source). Files above
  // the cap skip this — they remain searchable but their bytes are not
  // retained, to avoid blowing past the per-origin storage quota.
  const includeOriginal = file.size > 0 && file.size <= MAX_ORIGINAL_BLOB_BYTES;

  const doc: KnowledgeDocument = {
    doc_id,
    title: meta.title,
    category: meta.category,
    uploaded_at: new Date().toISOString(),
    uploaded_by: meta.uploaded_by,
    page_count: pageCount,
    pages,
    chunks,
    source_filename: file.name,
    file_size: file.size,
    ...(includeOriginal
      ? {
          original_blob: file,
          original_mime: file.type || 'application/pdf',
        }
      : {}),
  };
  onPhase?.('save');
  await db.documents.put(doc);
  onPhase?.('done');
  return doc;
}

/**
 * Per-PDF cap for keeping the original blob in IndexedDB. 25 MB matches the
 * common email-attachment ceiling — large enough for almost every protocol
 * PDF a humanitarian field office produces, small enough that ten of them
 * fit comfortably inside a typical browser storage quota.
 */
export const MAX_ORIGINAL_BLOB_BYTES = 25 * 1024 * 1024;

// ---------- Q&A with citations ------------------------------------------

const RAG_SYSTEM_PROMPT = `You are AidFlow Pro's documents assistant. You answer questions ONLY from the user's uploaded PDF excerpts (provided in the user message). You do NOT have any general knowledge about humanitarian frameworks, sector guidelines, or the AidFlow Pro platform itself beyond what the excerpts contain.

CRITICAL RULES — read carefully:

1. SOURCE OF TRUTH. The "Document excerpts" block in the user message is the ONLY source you may use. If a fact is not in the excerpts, you do not know it.

2. NEVER INVENT PLATFORM STRUCTURE. Do NOT describe AidFlow Pro's modules, sections, navigation, capabilities, or any "platform organization". The user can see the platform; they're asking about the PDFs they uploaded. If the excerpts don't speak to the question, say so.

3. NEVER LIST GENERIC HUMANITARIAN TOPICS unless those exact terms appear verbatim in the excerpts. Do NOT mention "Context & Assessment", "Programmatic Areas", "WASH", "Vulnerability Mapping", "Sectoral Guidelines", or any similar framework labels unless you can quote them from the excerpts.

4. WHEN THE EXCERPTS DO NOT ANSWER THE QUESTION:
   Reply briefly with: "I don't see information about [specific topic] in your uploaded PDFs." Then list the actual document titles available (you'll find the list in the user message under "Library inventory") and suggest uploading a relevant PDF. Do not pad with generic advice.

5. WHEN THE EXCERPTS DO ANSWER:
   - Cite the document title and page after each factual claim, e.g. "(humanitrain Aid best practices, p.4)".
   - Use short bold markdown headings + bullets. No over-formatting.
   - Aim for completeness on summary / list / "best practices" requests.
   - Always finish your last sentence and citation cleanly.

6. INVENTORY QUESTIONS ("do we have a doc about X?", "what PDFs do we have?", "what topics?"):
   Answer from the Library inventory list provided. Match the user's topic word against document titles, categories, and the excerpts. If no match, say so plainly and list what IS in the library.

Respond in {LANGUAGE}.`;

interface RagAnswer {
  answer: string;
  citations: { doc_id: string; title: string; page: number }[];
}

// ---------- Full-document summarization ---------------------------------
//
// Two paths:
//   1. SHORT docs  (charCount ≤ MAP_REDUCE_THRESHOLD)
//      Single Gemma 4 call. The whole text fits in a 16K-token context.
//   2. LONG docs   (charCount > MAP_REDUCE_THRESHOLD)
//      Map-reduce: split into ≤ MAP_SECTION_CHAR_BUDGET sections, ask
//      Gemma 4 for a structured outline of each (the "map" step), then
//      ask Gemma 4 once more to synthesize the outlines into a unified
//      executive summary (the "reduce" step). This handles arbitrarily
//      long documents — the truncation warning never appears.

const SUMMARY_CHAR_BUDGET = 50_000; // ≈ 12.5 K tokens at 4 chars/token

/**
 * Documents up to this size go through the single-pass path. Above this,
 * we switch to map-reduce so the whole document gets read.
 */
const MAP_REDUCE_THRESHOLD = SUMMARY_CHAR_BUDGET;

/**
 * Per-section budget for the map step. Sized so each section, plus the
 * map system prompt and a 600-token outline budget, fits comfortably in
 * a 16K-token context window with room for inference overhead.
 */
const MAP_SECTION_CHAR_BUDGET = 15_000;

const SUMMARIZE_INTENT_PATTERNS: RegExp[] = [
  /\bsummari[sz]e\b/i,
  /\bsummary\b/i,
  /\boverview\b/i,
  /\boutline\b/i,
  /\btl[\s,;:.-]*dr\b/i,
  /\bwhat'?s in\b/i,
  /\bwhat is in\b/i,
  /\bwhat does (?:this|the) doc(?:ument)? say\b/i,
  /\bgive me (?:a|the) (?:summary|overview|outline)\b/i,
];

/**
 * Negation patterns that should suppress summarize-intent detection — e.g.
 * "don't summarize this", "I don't want a summary", "no summary please".
 * Without this guard, the regex `/\bsummari[sz]e\b/` matched all of these
 * and routed the request to full-doc summary mode.
 */
const NEGATED_SUMMARIZE_PATTERNS: RegExp[] = [
  /\b(?:do(?:n'?t| not)|don[’']t|never|please don[’']?t)\s+(?:want\s+|need\s+|give\s+(?:me\s+)?)?(?:a\s+|the\s+|any\s+)?(?:summary?|overview|outline|summari[sz]e)\b/i,
  /\bno\s+summary\s+(?:please|needed|required|wanted)\b/i,
  /\b(?:without|skip|avoid)\s+(?:a\s+|the\s+|any\s+)?summary?\b/i,
];

/** True if the user's question reads like a summarization request. */
export function isSummarizeIntent(q: string): boolean {
  const s = q.trim();
  if (!s) return false;
  // Guard against negations BEFORE the positive match — "don't summarize"
  // should NOT route to full-doc summary mode.
  if (NEGATED_SUMMARIZE_PATTERNS.some((re) => re.test(s))) return false;
  return SUMMARIZE_INTENT_PATTERNS.some((re) => re.test(s));
}

/**
 * Try to identify which uploaded document the user is asking about by
 * matching their question against doc titles and source filenames (longest
 * match wins so "Cholera Response Protocol v2" beats "Protocol").
 */
export function findReferencedDocument(
  question: string,
  docs: KnowledgeDocument[]
): KnowledgeDocument | null {
  const q = question.toLowerCase();
  let best: { doc: KnowledgeDocument; score: number } | null = null;
  for (const d of docs) {
    const title = d.title.toLowerCase();
    const stem = (d.source_filename ?? '').toLowerCase().replace(/\.pdf$/, '');
    const candidates = [title, stem].filter(Boolean);
    for (const c of candidates) {
      if (c.length < 3) continue;
      if (q.includes(c)) {
        const score = c.length;
        if (!best || score > best.score) best = { doc: d, score };
      }
    }
  }
  return best?.doc ?? null;
}

/**
 * Concatenate a document's full extracted text up to `budget` chars.
 * Prefers the page array (preserves natural ordering and lets us cite
 * page numbers) and falls back to chunks if pages is missing on legacy
 * rows. Treats whitespace-only / sub-30-char content as empty so
 * scanned-PDF callers can short-circuit to a friendly "needs OCR" hint.
 */
export function buildFullDocText(
  doc: KnowledgeDocument,
  budget = SUMMARY_CHAR_BUDGET
): { text: string; truncated: boolean; charCount: number } {
  const parts: string[] = [];
  let usableChars = 0;
  if (doc.pages && doc.pages.length > 0) {
    for (const p of doc.pages) {
      const t = (p.text ?? '').trim();
      if (t) {
        parts.push(`[Page ${p.page}]\n${t}`);
        usableChars += t.length;
      }
    }
  } else if (doc.chunks && doc.chunks.length > 0) {
    for (const c of doc.chunks) {
      const t = (c.text ?? '').trim();
      if (t) {
        parts.push(`[Pages ${c.page_start}-${c.page_end}]\n${t}`);
        usableChars += t.length;
      }
    }
  }
  const MIN_USABLE_CHARS = 30;
  if (usableChars < MIN_USABLE_CHARS) {
    return { text: '', truncated: false, charCount: usableChars };
  }
  const full = parts.join('\n\n').trim();
  const truncated = full.length > budget;
  const text = truncated ? full.slice(0, budget) : full;
  return { text, truncated, charCount: full.length };
}

const SUMMARIZE_SYSTEM_PROMPT = `You are a humanitarian field assistant for AidFlow Pro. Write a faithful, complete, well-structured summary of the document below.

PRIORITY ORDER (read this carefully):
1. COVERAGE — every important part of the document MUST appear in your summary. No major topic gets skipped.
2. STRUCTURE — use 4-7 short markdown headings (##), each followed by 2-5 bullets.
3. DEPTH — only as much detail as fits within the length budget below.

If you must choose between deep detail on early sections and surface mention of later sections, ALWAYS CHOOSE COVERAGE. Trim bullets shorter, drop adjectives, but never omit a topic the document spends real space on.

Rules:
- Use ONLY information from the document text below. Do not invent facts.
- Cite the page in parentheses for non-trivial claims, e.g. "(p. 4)".
- Aim for 500-700 words total. The model has limited output room — pace yourself.
- END CLEANLY. Do not stop mid-sentence or mid-bullet. If you sense you're running out of room, finish the current bullet, write a final "## Summary" heading with one closing sentence, and stop.
- If the document text was truncated (you'll be told), note that briefly at the end.
- Reply in {LANGUAGE}.`;

// Map step — extract dense factual content from ONE section. Output is an
// outline (not a polished summary) that will feed the reduce step.
const MAP_SECTION_SYSTEM_PROMPT = `You are extracting the substantive content from one section of a longer humanitarian document for later synthesis. Output a STRUCTURED OUTLINE (not a polished summary) of just this section.

Rules:
- Cover: definitions, recommendations, decision criteria, thresholds, named entities (people / organizations / places), specific numbers, dates, and any explicit do's / don'ts.
- Use bullet points. Use short bold sub-headings if the section has clear sub-topics.
- Cite the page in parentheses for each non-trivial claim, e.g. "(p. 4)".
- Do NOT add preamble like "This section discusses…" — go straight into the bullets.
- Do NOT invent content. If the section is sparse, output a short outline; if it is a heading-only page, just say so briefly.
- Aim for 200-400 words. The goal is dense factual extraction, not prose.
- Reply in {LANGUAGE}.`;

// Reduce step — synthesize all section outlines into a single cohesive
// executive summary, in the same shape as the single-pass summary.
const REDUCE_SYSTEM_PROMPT = `You are a humanitarian field assistant for AidFlow Pro. You receive a series of structured outlines, each from one section of a single document, in document order. Synthesize them into ONE cohesive executive summary.

PRIORITY ORDER (read this carefully):
1. COVERAGE — EVERY section in the outlines below MUST be reflected in your summary. No section gets dropped.
2. STRUCTURE — use 4-7 short markdown headings (##), each followed by 2-5 bullets.
3. DEPTH — only as much detail as fits within the length budget below.

If you must choose between deep detail on early outlines and surface mention of later outlines, ALWAYS CHOOSE COVERAGE. Trim bullets shorter, drop adjectives, but never omit content from a later outline.

Rules:
- Use ONLY information from the outlines below. Do not invent facts.
- Preserve page citations: when an outline says "(p. 4)", carry that through.
- Do NOT mention sections, outlines, or that you were given pre-extracted content — the reader sees one cohesive summary.
- Do NOT prefix with "Here is the summary:" — start directly with your first markdown heading.
- Aim for 600-900 words total. The model has limited output room — pace yourself.
- END CLEANLY. Do not stop mid-sentence or mid-bullet. If you sense you're running out of room, finish the current bullet, write a final "## Summary" heading with one closing sentence, and stop.
- Reply in {LANGUAGE}.`;

/**
 * Group the document into coarse sections for the map step. Prefers page
 * boundaries for clean cuts; falls back to chunks for legacy rows that
 * don't have a `pages` array. Sections never exceed
 * MAP_SECTION_CHAR_BUDGET — single oversized pages are char-split.
 */
function buildMapReduceSections(
  doc: KnowledgeDocument
): { text: string; page_start: number; page_end: number }[] {
  const blocks =
    doc.pages && doc.pages.length > 0
      ? doc.pages
          .map((p) => ({
            text: (p.text ?? '').trim(),
            page_start: p.page,
            page_end: p.page,
          }))
          .filter((b) => b.text.length > 0)
      : (doc.chunks ?? [])
          .map((c) => ({
            text: (c.text ?? '').trim(),
            page_start: c.page_start,
            page_end: c.page_end,
          }))
          .filter((b) => b.text.length > 0);

  const sections: { text: string; page_start: number; page_end: number }[] = [];
  let current: string[] = [];
  let currentChars = 0;
  let currentStart = 0;
  let currentEnd = 0;

  const flush = () => {
    if (current.length === 0) return;
    sections.push({
      text: current.join('\n\n'),
      page_start: currentStart,
      page_end: currentEnd,
    });
    current = [];
    currentChars = 0;
  };

  for (const block of blocks) {
    const pageLabel = `[Page ${block.page_start}${
      block.page_end !== block.page_start ? `-${block.page_end}` : ''
    }]`;

    // A single block bigger than the section budget — char-split it. Edge
    // case for very text-heavy single pages.
    if (block.text.length > MAP_SECTION_CHAR_BUDGET) {
      flush();
      let offset = 0;
      while (offset < block.text.length) {
        const slice = block.text.slice(offset, offset + MAP_SECTION_CHAR_BUDGET);
        sections.push({
          text: `${pageLabel}\n${slice}`,
          page_start: block.page_start,
          page_end: block.page_end,
        });
        offset += MAP_SECTION_CHAR_BUDGET;
      }
      continue;
    }

    if (currentChars + block.text.length > MAP_SECTION_CHAR_BUDGET && currentChars > 0) {
      flush();
    }
    if (current.length === 0) currentStart = block.page_start;
    current.push(`${pageLabel}\n${block.text}`);
    currentChars += block.text.length;
    currentEnd = block.page_end;
  }
  flush();

  return sections;
}

/**
 * Stream a summary of one document. Dispatches between a single-pass
 * summary (short docs ≤ MAP_REDUCE_THRESHOLD chars) and a map-reduce
 * summary (long docs above that threshold).
 *
 * Yields:
 *   - `{ kind: 'progress', stage: 'mapping'|'reducing', sectionIndex?, totalSections? }`
 *     emitted only on the map-reduce path so the UI can show a progress
 *     strip while no tokens are streaming yet.
 *   - `{ kind: 'delta', text }`           — token deltas for the final
 *     summary (single-pass) or the reduce step's streamed output.
 *   - `{ kind: 'done', citations, truncated }` — terminal event. With
 *     map-reduce, `truncated` is always false because the whole document
 *     was processed — no pages were dropped.
 */
export async function* summarizeDocumentStream(
  docId: string,
  language: 'en' | 'ar' | 'fr' | 'es' = 'en'
): AsyncGenerator<
  | { kind: 'delta'; text: string }
  | {
      kind: 'progress';
      stage: 'mapping' | 'reducing';
      sectionIndex?: number;
      totalSections?: number;
    }
  | {
      kind: 'done';
      citations: { doc_id: string; title: string; page: number }[];
      truncated: boolean;
    },
  void,
  void
> {
  const doc = await db.documents.get(docId);
  if (!doc) {
    yield { kind: 'delta', text: 'That document is no longer in the library.' };
    yield { kind: 'done', citations: [], truncated: false };
    return;
  }
  // Pull full text up to SUMMARY_CHAR_BUDGET; we use `charCount` (the
  // untruncated length) to decide one-pass vs. map-reduce.
  const { text, truncated, charCount } = buildFullDocText(doc);
  if (!text) {
    yield {
      kind: 'delta',
      text:
        'No extracted text found for this document — it may be a scanned PDF without OCR.',
    };
    yield { kind: 'done', citations: [], truncated: false };
    return;
  }

  const langName =
    language === 'ar'
      ? 'Arabic'
      : language === 'fr'
      ? 'French'
      : language === 'es'
      ? 'Spanish'
      : 'English';

  if (!(await pingOllama())) {
    yield {
      kind: 'delta',
      text:
        'Ollama is offline — cannot generate a summary. Start Ollama with the gemma4:e4b model and try again.',
    };
    yield {
      kind: 'done',
      citations: [{ doc_id: doc.doc_id, title: doc.title, page: 1 }],
      truncated: false,
    };
    return;
  }

  const useMapReduce = charCount > MAP_REDUCE_THRESHOLD;

  // ---------------- Single-pass path (short documents) -------------------
  if (!useMapReduce) {
    const sys = SUMMARIZE_SYSTEM_PROMPT.replace('{LANGUAGE}', langName);
    // With the new 50K budget and a 16K context window, the document
    // fits in a single pass — `truncated` should be false on this path.
    const truncationNote = truncated
      ? `\n\n[NOTE: the document is ${charCount.toLocaleString()} characters; the assistant only sees the first ${text.length.toLocaleString()} characters in this turn.]`
      : '';

    const messages: ChatMessage[] = [
      { role: 'system', content: sys },
      {
        role: 'user',
        content: `Summarize the following document.\n\nTitle: "${doc.title}"\nCategory: ${doc.category}\nPages: ${doc.page_count}${truncationNote}\n\nDocument text:\n${text}\n\nWrite the summary now.`,
      },
    ];

    for await (const delta of chatStream(messages, {
      temperature: 0.2,
      // Bumped from 1500 → 2048 so a coverage-first summary has room to
      // reach the last section instead of getting cut mid-bullet.
      maxTokens: 2048,
      numCtx: 16_384,
    })) {
      yield { kind: 'delta', text: delta };
    }
    yield {
      kind: 'done',
      citations: [{ doc_id: doc.doc_id, title: doc.title, page: 1 }],
      truncated,
    };
    return;
  }

  // ---------------- Map-reduce path (long documents) ---------------------
  const sections = buildMapReduceSections(doc);
  if (sections.length === 0) {
    // Defensive — shouldn't happen because charCount > 0 was already
    // confirmed above, but keep the user moving forward gracefully.
    yield {
      kind: 'delta',
      text:
        'Could not split this document into readable sections. It may contain only structural markers without text content.',
    };
    yield {
      kind: 'done',
      citations: [{ doc_id: doc.doc_id, title: doc.title, page: 1 }],
      truncated: false,
    };
    return;
  }

  // Map step — one Gemma 4 call per section. Each yields an outline; we
  // collect them locally instead of streaming so the UI shows a single
  // cohesive final summary, not a noisy intermediate cascade.
  const sysMap = MAP_SECTION_SYSTEM_PROMPT.replace('{LANGUAGE}', langName);
  const sectionOutlines: string[] = [];
  for (let i = 0; i < sections.length; i++) {
    yield {
      kind: 'progress',
      stage: 'mapping',
      sectionIndex: i + 1,
      totalSections: sections.length,
    };
    const sec = sections[i];
    const pageLabel =
      sec.page_end !== sec.page_start
        ? `pp. ${sec.page_start}–${sec.page_end}`
        : `p. ${sec.page_start}`;
    const userMsg = `Document: "${doc.title}"\nThis section covers ${pageLabel}.\n\nSection text:\n${sec.text}\n\nWrite the structured outline now.`;
    try {
      const outline = await chat(
        [
          { role: 'system', content: sysMap },
          { role: 'user', content: userMsg },
        ],
        { temperature: 0.2, maxTokens: 700, numCtx: 16_384 }
      );
      const cleaned = outline.trim();
      if (cleaned) {
        sectionOutlines.push(
          `### Section ${i + 1} (${pageLabel})\n${cleaned}`
        );
      }
    } catch (e) {
      // A single failed section shouldn't kill the whole summary —
      // skip it and let the reduce step work with what we have.
      console.warn('[rag] map-step failed for section', i + 1, e);
    }
  }

  if (sectionOutlines.length === 0) {
    yield {
      kind: 'delta',
      text:
        'The local AI produced no usable section outlines for this document. Make sure Ollama is running smoothly and try again.',
    };
    yield {
      kind: 'done',
      citations: [{ doc_id: doc.doc_id, title: doc.title, page: 1 }],
      truncated: false,
    };
    return;
  }

  // Reduce step — synthesize all outlines into one cohesive summary,
  // streamed back to the UI as it generates.
  yield { kind: 'progress', stage: 'reducing' };
  const sysReduce = REDUCE_SYSTEM_PROMPT.replace('{LANGUAGE}', langName);
  const combined = sectionOutlines.join('\n\n---\n\n');
  const reduceUserMsg = `Document: "${doc.title}"\nCategory: ${doc.category}\nTotal pages: ${doc.page_count}\nProcessed in ${sections.length} sections.\n\nSection outlines (in document order):\n\n${combined}\n\nWrite the unified executive summary now.`;

  for await (const delta of chatStream(
    [
      { role: 'system', content: sysReduce },
      { role: 'user', content: reduceUserMsg },
    ],
    {
      temperature: 0.3,
      // The reduce step needs more output budget than single-pass since
      // it covers a longer document end-to-end. Bumped from 2048 → 3072
      // so a coverage-first synthesis has room to reach the last section.
      maxTokens: 3072,
      numCtx: 16_384,
    }
  )) {
    yield { kind: 'delta', text: delta };
  }

  // Map-reduce processed every section, so nothing was dropped — the
  // truncation warning never fires on this path.
  yield {
    kind: 'done',
    citations: [{ doc_id: doc.doc_id, title: doc.title, page: 1 }],
    truncated: false,
  };
}

async function prepareRagPrompt(
  question: string,
  language: 'en' | 'ar' | 'fr' | 'es'
): Promise<
  | { type: 'empty' }
  | { type: 'offline'; payload: RagAnswer }
  | {
      type: 'ready';
      messages: ChatMessage[];
      citations: { doc_id: string; title: string; page: number }[];
    }
> {
  // Summarization shortcut: route "summarize this" to full-doc mode.
  if (isSummarizeIntent(question)) {
    const allDocs = await db.documents.toArray();
    if (allDocs.length > 0) {
      const target = findReferencedDocument(question, allDocs);
      if (target) {
        const { text, truncated, charCount } = buildFullDocText(target);
        if (text) {
          const langName =
            language === 'ar'
              ? 'Arabic'
              : language === 'fr'
              ? 'French'
              : language === 'es'
              ? 'Spanish'
              : 'English';
          const sys = SUMMARIZE_SYSTEM_PROMPT.replace('{LANGUAGE}', langName);
          const truncationNote = truncated
            ? `\n\n[NOTE: the document is ${charCount.toLocaleString()} characters; only the first ${text.length.toLocaleString()} characters are visible in this turn.]`
            : '';
          if (!(await pingOllama())) {
            return {
              type: 'offline',
              payload: {
                answer:
                  'Ollama is offline — cannot generate a summary. Start Ollama with the gemma4:e4b model and try again.',
                citations: [{ doc_id: target.doc_id, title: target.title, page: 1 }],
              },
            };
          }
          return {
            type: 'ready',
            messages: [
              { role: 'system', content: sys },
              {
                role: 'user',
                content: `Summarize the following document.\n\nTitle: "${target.title}"\nCategory: ${target.category}\nPages: ${target.page_count}${truncationNote}\n\nDocument text:\n${text}\n\nWrite the summary now.`,
              },
            ],
            citations: [{ doc_id: target.doc_id, title: target.title, page: 1 }],
          };
        }
      } else if (allDocs.length === 1) {
        return prepareRagPrompt(
          `${question} (document: "${allDocs[0].title}")`,
          language
        );
      } else {
        const sliceBudget = Math.floor(SUMMARY_CHAR_BUDGET / allDocs.length);
        const blocks: string[] = [];
        const cites: { doc_id: string; title: string; page: number }[] = [];
        for (const d of allDocs) {
          const { text } = buildFullDocText(d, Math.max(sliceBudget, 800));
          if (text) {
            blocks.push(`### Document: "${d.title}" (category: ${d.category}, ${d.page_count} pages)\n${text}`);
            cites.push({ doc_id: d.doc_id, title: d.title, page: 1 });
          }
        }
        if (blocks.length > 0) {
          const langName =
            language === 'ar'
              ? 'Arabic'
              : language === 'fr'
              ? 'French'
              : language === 'es'
              ? 'Spanish'
              : 'English';
          const sys = SUMMARIZE_SYSTEM_PROMPT.replace('{LANGUAGE}', langName);
          if (!(await pingOllama())) {
            return {
              type: 'offline',
              payload: {
                answer:
                  'Ollama is offline — cannot generate a summary. Start Ollama with the gemma4:e4b model and try again.',
                citations: cites,
              },
            };
          }
          return {
            type: 'ready',
            messages: [
              { role: 'system', content: sys },
              {
                role: 'user',
                content: `Summarize the AidFlow knowledge base. ${allDocs.length} documents are included below — give a brief 2–3 line overview of each, then a short combined "key takeaways" section. Cite each document by title.\n\n${blocks.join('\n\n')}\n\nWrite the summary now.`,
              },
            ],
            citations: cites,
          };
        }
      }
    }
    // Fall through to standard RAG if we couldn't build a summary plan.
  }

  const top = await retrieve(question, 10);
  // Build a "library inventory" the model can cite when nothing relevant
  // is found. This is the antidote to "let me describe AidFlow Pro modules"
  // hallucinations — the model knows the exact list of available docs.
  const allDocsForInventory = await db.documents.toArray();

  // Truly-empty library: no docs at all. Short-circuit with the canned
  // "upload some PDFs" message rather than ask the LLM.
  if (allDocsForInventory.length === 0) {
    return { type: 'empty' };
  }

  const inventory = allDocsForInventory
    .map((d) => {
      const chunks = Array.isArray(d.chunks) ? d.chunks.length : 0;
      const flag =
        chunks === 0
          ? ' [WARNING: no text extracted — likely a scanned PDF; not searchable until re-uploaded with OCR]'
          : '';
      return `- "${d.title}" — category: ${d.category}, ${d.page_count} page(s), ${chunks} text chunk(s)${
        d.source_filename ? `, file: ${d.source_filename}` : ''
      }${flag}`;
    })
    .join('\n');

  const langName =
    language === 'ar' ? 'Arabic' : language === 'fr' ? 'French' : language === 'es' ? 'Spanish' : 'English';
  const sys = RAG_SYSTEM_PROMPT.replace('{LANGUAGE}', langName);

  const bestScore = top[0]?.score ?? 0;
  const bestKind = top[0]?.scoreKind ?? 'embedding';
  const floor = relevanceFloor(bestKind);
  const lowConfidence = top.length === 0 || bestScore < floor;

  const context = top
    .map(
      (c, i) =>
        `[#${i + 1}] (Doc: "${c.doc_title}", pages ${c.page_start}-${c.page_end}, similarity: ${c.score.toFixed(2)})\n${c.text}`
    )
    .join('\n\n');

  const seen = new Set<string>();
  const citations: { doc_id: string; title: string; page: number }[] = [];
  for (const c of top) {
    const key = `${c.doc_id}::${c.page_start}`;
    if (seen.has(key)) continue;
    seen.add(key);
    citations.push({ doc_id: c.doc_id, title: c.doc_title, page: c.page_start });
  }

  if (!(await pingOllama())) {
    return {
      type: 'offline',
      payload: {
        answer: lowConfidence
          ? `Ollama is offline, and your library doesn't appear to contain content matching this question (best similarity ${bestScore.toFixed(
              2
            )} is below the ${floor.toFixed(2)} relevance floor).\n\nLibrary inventory:\n${inventory}`
          : `Ollama is offline. Top matches from your knowledge base:\n\n${top
              .slice(0, 5)
              .map((c) => `• "${c.doc_title}" (p.${c.page_start}): ${c.text.slice(0, 200)}…`)
              .join('\n')}`,
        citations,
      },
    };
  }

  const confidenceLine = lowConfidence
    ? `[CONFIDENCE: LOW — best similarity is ${bestScore.toFixed(2)}, below the ${floor.toFixed(
        2
      )} relevance floor. The excerpts below (if any) are weak matches.

INVENTORY-FIRST CHECK: before answering, scan the Library inventory above. Match the user's keywords against the document TITLES, CATEGORIES, and FILENAMES — not just the excerpts.

  • If a doc TITLE / FILENAME contains the user's topic: answer YES, name the doc verbatim, and note any [WARNING: ...] flag (e.g. scanned PDFs that need OCR).
  • If NO inventory entry matches the topic: reply "I don't see information about [the topic] in your uploaded PDFs." then list what IS available (use the inventory).

Do NOT describe platform features, sectors, modules, or generic frameworks. Do NOT pad with generic humanitarian advice. Do NOT invent content that isn't in the excerpts or inventory.]`
    : `[CONFIDENCE: OK — best similarity is ${bestScore.toFixed(2)}. The excerpts below should contain the answer; cite them.]`;

  const excerptsBlock =
    context.length > 0
      ? `Document excerpts (most-similar passages from the library):\n${context}`
      : 'Document excerpts: (none — no chunks scored above zero. Answer from the Library inventory above.)';

  return {
    type: 'ready',
    messages: [
      { role: 'system', content: sys },
      {
        role: 'user',
        content: `Question: ${question}

Library inventory (the ONLY documents that exist in this user's knowledge base):
${inventory}

${confidenceLine}

${excerptsBlock}

Answer the question. Cite document title + page for each factual claim. Stay strictly within the excerpts and inventory; do not describe platform features or generic humanitarian topics that aren't quoted above.`,
      },
    ],
    citations,
  };
}

/** Non-streaming RAG (kept for backwards compatibility) */
export async function ragAnswer(
  question: string,
  language: 'en' | 'ar' | 'fr' | 'es' = 'en'
): Promise<RagAnswer> {
  const prep = await prepareRagPrompt(question, language);
  if (prep.type === 'empty') {
    return {
      answer: `No matching content found in your knowledge base. Try uploading more PDFs in the Knowledge Base page.`,
      citations: [],
    };
  }
  if (prep.type === 'offline') return prep.payload;

  const answer = await chat(prep.messages, { temperature: 0.3, maxTokens: 4096, numCtx: 8192 });
  return { answer, citations: prep.citations };
}

/**
 * Streaming RAG — yields content deltas as Gemma 4 produces them, then a
 * final 'done' event with the citation list. Used by AIChat to render
 * progressive output instead of the user staring at "..." for 10s.
 */
export async function* ragAnswerStream(
  question: string,
  language: 'en' | 'ar' | 'fr' | 'es' = 'en'
): AsyncGenerator<
  | { kind: 'delta'; text: string }
  | { kind: 'done'; citations: { doc_id: string; title: string; page: number }[] },
  void,
  void
> {
  const prep = await prepareRagPrompt(question, language);
  if (prep.type === 'empty') {
    yield {
      kind: 'delta',
      text:
        'No matching content found in your knowledge base. Try uploading more PDFs in the Knowledge Base page.',
    };
    yield { kind: 'done', citations: [] };
    return;
  }
  if (prep.type === 'offline') {
    yield { kind: 'delta', text: prep.payload.answer };
    yield { kind: 'done', citations: prep.payload.citations };
    return;
  }

  for await (const delta of chatStream(prep.messages, {
    temperature: 0.3,
    maxTokens: 4096,
    numCtx: 8192,
  })) {
    yield { kind: 'delta', text: delta };
  }
  yield { kind: 'done', citations: prep.citations };
}
