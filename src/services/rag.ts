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
import { embed, pingOllama, chat } from './ollama';
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

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length && i < b.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

function keywordScore(query: string, text: string): number {
  const q = query.toLowerCase().split(/\W+/).filter((w) => w.length > 2);
  const t = text.toLowerCase();
  let hits = 0;
  for (const w of q) if (t.includes(w)) hits += 1;
  return hits / Math.max(q.length, 1);
}

// ---------- Top-K retrieval ----------------------------------------------

export interface RetrievedChunk extends KnowledgeChunk {
  score: number;
  doc_title: string;
}

export async function retrieve(query: string, k = 5): Promise<RetrievedChunk[]> {
  const docs = await db.documents.toArray();
  const allChunks: { chunk: KnowledgeChunk; doc_title: string }[] = [];
  for (const d of docs) for (const c of d.chunks) allChunks.push({ chunk: c, doc_title: d.title });

  const ollamaUp = await pingOllama();
  let scored: RetrievedChunk[];

  if (ollamaUp) {
    try {
      const qEmbed = await embed(query);
      scored = allChunks.map(({ chunk, doc_title }) => ({
        ...chunk,
        doc_title,
        score: chunk.embedding ? cosine(qEmbed, chunk.embedding) : keywordScore(query, chunk.text),
      }));
    } catch {
      scored = allChunks.map(({ chunk, doc_title }) => ({
        ...chunk,
        doc_title,
        score: keywordScore(query, chunk.text),
      }));
    }
  } else {
    scored = allChunks.map(({ chunk, doc_title }) => ({
      ...chunk,
      doc_title,
      score: keywordScore(query, chunk.text),
    }));
  }

  return scored.filter((s) => s.score > 0).sort((a, b) => b.score - a.score).slice(0, k);
}

// ---------- Ingestion ----------------------------------------------------

export async function ingestPdf(
  file: File,
  meta: { title: string; category: KnowledgeDocument['category']; uploaded_by: string }
): Promise<KnowledgeDocument> {
  const { pages, pageCount } = await extractTextFromPdf(file);
  const chunkSpecs = chunkPages(pages);
  const useEmbed = await pingOllama();

  const chunks: KnowledgeChunk[] = [];
  for (let i = 0; i < chunkSpecs.length; i++) {
    const c = chunkSpecs[i];
    const chunk: KnowledgeChunk = {
      chunk_id: `${file.name}-${i}`,
      doc_id: '', // set after we mint doc_id
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
  }

  const doc_id = `D-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  for (const c of chunks) c.doc_id = doc_id;

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
  await db.documents.put(doc);
  return doc;
}

// ---------- Q&A with citations ------------------------------------------

import { chatStream } from './ollama';

const RAG_SYSTEM_PROMPT = `You are a humanitarian field assistant for AidFlow Pro. You have access to organizational knowledge documents (uploaded PDFs). Use the retrieved document excerpts below to answer the user's question.

Rules:
- Use the excerpts as your source of truth. Do not invent facts not in the excerpts.
- Cite the document title and page in parentheses for each claim, e.g. (Source.pdf, p.4).
- Aim for COMPLETENESS when the user asks for a summary, list, or "best practices" — do not stop early. Cover every relevant point in the excerpts.
- If the excerpts do not contain enough information to answer, say so clearly and suggest uploading more documents.
- Use clear markdown: short bold headings, bulleted lists, no over-formatting.
- Always finish your last sentence and citation cleanly. Never truncate mid-thought.

Respond in {LANGUAGE}.`;

interface RagAnswer {
  answer: string;
  citations: { doc_id: string; title: string; page: number }[];
}

/**
 * Build the messages list and unique citation list shared by both
 * `ragAnswer` (returns full text) and `ragAnswerStream` (yields deltas).
 */
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
  const top = await retrieve(question, 5);
  if (top.length === 0) return { type: 'empty' };

  const langName =
    language === 'ar' ? 'Arabic' : language === 'fr' ? 'French' : language === 'es' ? 'Spanish' : 'English';
  const sys = RAG_SYSTEM_PROMPT.replace('{LANGUAGE}', langName);

  const context = top
    .map(
      (c, i) =>
        `[#${i + 1}] (Doc: "${c.doc_title}", pages ${c.page_start}-${c.page_end})\n${c.text}`
    )
    .join('\n\n');

  // Dedupe citations (same doc could surface twice via different chunks)
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
        answer: `Ollama is offline. Top matches from your knowledge base:\n\n${top
          .map((c) => `• "${c.doc_title}" (p.${c.page_start}): ${c.text.slice(0, 200)}…`)
          .join('\n')}`,
        citations,
      },
    };
  }

  return {
    type: 'ready',
    messages: [
      { role: 'system', content: sys },
      {
        role: 'user',
        content: `Question: ${question}\n\nRelevant document excerpts:\n${context}\n\nAnswer the question fully. Cite the document title and page for each factual claim. Do not truncate.`,
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
