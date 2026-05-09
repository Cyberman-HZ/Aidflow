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
  };
  onPhase?.('save');
  await db.documents.put(doc);
  onPhase?.('done');
  return doc;
}

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

const SUMMARY_CHAR_BUDGET = 24_000; // ≈ 6 K tokens at 4 chars/token

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

const SUMMARIZE_SYSTEM_PROMPT = `You are a humanitarian field assistant for AidFlow Pro. The user wants a summary of an organizational document. Write a concise, faithful, structured summary based on the document text provided.

Rules:
- Use ONLY information from the document text below. Do not invent facts.
- Structure the answer with short bold headings (Markdown), then bullet points or short paragraphs.
- Cover: purpose, key sections, critical guidance, and any explicit do's / don'ts. Aim for completeness over brevity, but stay tight — no padding.
- Cite the page in parentheses for non-trivial claims, e.g. "(p. 4)".
- If the document text was truncated (you'll be told), say so plainly at the end so the user knows to ask follow-ups for later sections.
- Reply in {LANGUAGE}.`;

/**
 * Stream a summary of one document. Yields content deltas, then a 'done'
 * event with citation info (the doc itself).
 */
export async function* summarizeDocumentStream(
  docId: string,
  language: 'en' | 'ar' | 'fr' | 'es' = 'en'
): AsyncGenerator<
  | { kind: 'delta'; text: string }
  | { kind: 'done'; citations: { doc_id: string; title: string; page: number }[]; truncated: boolean },
  void,
  void
> {
  const doc = await db.documents.get(docId);
  if (!doc) {
    yield { kind: 'delta', text: 'That document is no longer in the library.' };
    yield { kind: 'done', citations: [], truncated: false };
    return;
  }
  const { text, truncated, charCount } = buildFullDocText(doc);
  if (!text) {
    yield {
      kind: 'delta',
      text: 'No extracted text found for this document — it may be a scanned PDF without OCR.',
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
  const sys = SUMMARIZE_SYSTEM_PROMPT.replace('{LANGUAGE}', langName);

  if (!(await pingOllama())) {
    yield {
      kind: 'delta',
      text:
        'Ollama is offline — cannot generate a summary. Start Ollama with the gemma4:e4b model and try again.',
    };
    yield {
      kind: 'done',
      citations: [{ doc_id: doc.doc_id, title: doc.title, page: 1 }],
      truncated,
    };
    return;
  }

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
    maxTokens: 1500,
    numCtx: 8192,
  })) {
    yield { kind: 'delta', text: delta };
  }
  yield {
    kind: 'done',
    citations: [{ doc_id: doc.doc_id, title: doc.title, page: 1 }],
    truncated,
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
