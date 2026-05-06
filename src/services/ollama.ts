// Ollama client — talks directly from the browser to a local Ollama instance.
//
// Per the user's choice (no backend), the React app calls Ollama's native
// /api/chat endpoint at http://localhost:11434 by default. We use the native
// API instead of the OpenAI-compatible /v1/chat/completions because the
// native one lets us set `options.num_ctx` to expand the context window.
// (OpenAI-compat endpoint always uses Ollama's default num_ctx ~2048, which
// truncates large system prompts and causes the model to hallucinate.)
//
// The user must launch Ollama with `OLLAMA_ORIGINS=*` so that the browser
// can reach it cross-origin.
//
// All system prompts mirror PDF Section 6.2.

import type {
  Family,
  PrioritizationResult,
  ChatMessage,
} from '@/types';
import { useSettingsStore } from '@/stores/settingsStore';
import { computeRuleScore } from './priorityRules';
import { db } from '@/db/database';

interface ChatResponse {
  message?: { role: string; content: string };
  done?: boolean;
}

interface EmbeddingResponse {
  embedding: number[];
}

// num_ctx — how many tokens the model can see at once.
// Gemma 4 E4B supports up to 128K, but each doubling slows inference.
// 16384 fits our full app snapshot (families + distributions + 240+ Starlink
// retailers + 130 country availability + Wikipedia + chat history) with room
// to spare; below 16K the retailers block can get truncated and the model
// starts hallucinating retailer names.
const DEFAULT_NUM_CTX = 16384;

function getConfig() {
  const s = useSettingsStore.getState();
  return {
    baseUrl: (s.ollamaBaseUrl || (import.meta.env.VITE_OLLAMA_BASE_URL as string) || 'http://localhost:11434').replace(/\/$/, ''),
    model: s.ollamaModel || (import.meta.env.VITE_OLLAMA_MODEL as string) || 'gemma4:e4b',
    embedModel: s.embedModel || (import.meta.env.VITE_OLLAMA_EMBED_MODEL as string) || 'nomic-embed-text',
  };
}

async function withTimeout<T>(p: Promise<T>, ms = 60_000): Promise<T> {
  return await Promise.race([
    p,
    new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`Ollama request timeout after ${ms}ms`)), ms)),
  ]);
}

// ---------- Health check --------------------------------------------------

export async function pingOllama(): Promise<boolean> {
  try {
    const { baseUrl } = getConfig();
    const r = await withTimeout(fetch(`${baseUrl}/api/tags`, { method: 'GET' }), 5_000);
    return r.ok;
  } catch {
    return false;
  }
}

// ---------- Chat (single completion) --------------------------------------

interface ChatOpts {
  temperature?: number;
  maxTokens?: number;
  numCtx?: number;
}

export async function chat(messages: ChatMessage[], opts: ChatOpts = {}): Promise<string> {
  const { baseUrl, model } = getConfig();
  const body = {
    model,
    messages: messages.map((m) => ({ role: m.role, content: m.content })),
    stream: false,
    options: {
      num_ctx: opts.numCtx ?? DEFAULT_NUM_CTX,
      temperature: opts.temperature ?? 0.7,
      num_predict: opts.maxTokens ?? 1024,
    },
  };
  const res = await withTimeout(
    fetch(`${baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  );
  if (!res.ok) throw new Error(`Ollama chat failed: ${res.status} ${res.statusText}`);
  const data = (await res.json()) as ChatResponse;
  return data.message?.content ?? '';
}

// ---------- Streaming chat (for Assistant page) ---------------------------
// Ollama's native /api/chat streams newline-delimited JSON (NOT OpenAI SSE).

export async function* chatStream(
  messages: ChatMessage[],
  opts: ChatOpts = {}
): AsyncGenerator<string, void, void> {
  const { baseUrl, model } = getConfig();
  const body = {
    model,
    messages: messages.map((m) => ({ role: m.role, content: m.content })),
    stream: true,
    options: {
      num_ctx: opts.numCtx ?? DEFAULT_NUM_CTX,
      temperature: opts.temperature ?? 0.7,
      num_predict: opts.maxTokens ?? 1024,
    },
  };
  const res = await fetch(`${baseUrl}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok || !res.body) throw new Error(`Ollama stream failed: ${res.status}`);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const raw of lines) {
      const line = raw.trim();
      if (!line) continue;
      try {
        const obj = JSON.parse(line) as ChatResponse;
        const delta = obj.message?.content;
        if (delta) yield delta;
        if (obj.done) return;
      } catch {
        // ignore non-JSON keep-alives
      }
    }
  }
}

// ---------- Embeddings (RAG) ----------------------------------------------

export async function embed(text: string): Promise<number[]> {
  const { baseUrl, embedModel } = getConfig();
  const res = await withTimeout(
    fetch(`${baseUrl}/api/embeddings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: embedModel, prompt: text }),
    }),
    30_000
  );
  if (!res.ok) throw new Error(`Embedding failed: ${res.status}`);
  const data = (await res.json()) as EmbeddingResponse;
  return data.embedding ?? [];
}

// ---------- Prioritization (with rule-based fallback) ---------------------

const PRIORITIZATION_SYSTEM_PROMPT = `You are AidFlow Pro's humanitarian aid prioritization AI. You receive structured JSON data about impacted families. Your job is to rank families by urgency for aid distribution. Score each family 0-100. Factors to consider: number of children under 5 (+20 pts each), pregnant/nursing women (+15), elderly members 65+ (+10 each), medical conditions (+25 for critical, +10 for chronic), days since last aid received (×2 pts per day), displacement status (+15 if recently displaced), refugee (+10), no income (+15), minimal income (+5), new need flagged by field worker (+20), received aid within 3 days (-30). Cap each family's score at 100 and floor at 0. Return strictly valid JSON: an array of objects with keys family_id, priority_score (number), priority_level (CRITICAL|HIGH|MEDIUM|NORMAL), reason (1 sentence), recommended_items (array of 1-4 short strings), sector. Sort the array by priority_score descending. Respond ONLY with the JSON — no markdown, no commentary. Respond in {LANGUAGE}.`;

export async function prioritizeFamilies(
  families: Family[],
  language: 'en' | 'ar' | 'fr' | 'es' = 'en'
): Promise<PrioritizationResult[]> {
  // Fallback: if Ollama is unreachable, use the deterministic rule engine
  // so the app remains useful even without AI.
  if (!(await pingOllama())) {
    return families.map((f) => computeRuleScore(f));
  }

  const langName =
    language === 'ar' ? 'Arabic' : language === 'fr' ? 'French' : language === 'es' ? 'Spanish' : 'English';
  const sys = PRIORITIZATION_SYSTEM_PROMPT.replace('{LANGUAGE}', langName);

  const familiesPayload = families.map((f) => ({
    family_id: f.family_id,
    head_name: f.head_name,
    member_count: f.member_count,
    children_under_5: f.children_under_5,
    elderly_count: f.elderly_count,
    has_pregnant_member: f.has_pregnant_member,
    medical_conditions: f.medical_conditions,
    displacement_status: f.displacement_status,
    income_level: f.income_level,
    sector: f.location_sector,
    days_since_last_aid: f.last_aid_at
      ? Math.floor((Date.now() - new Date(f.last_aid_at).getTime()) / 86_400_000)
      : 999,
    new_need_flagged: f.new_need_flagged ?? false,
  }));

  try {
    const raw = await chat(
      [
        { role: 'system', content: sys },
        { role: 'user', content: JSON.stringify({ families: familiesPayload }) },
      ],
      { temperature: 0.2, maxTokens: 2048 }
    );

    const cleaned = raw
      .replace(/^```(?:json)?/i, '')
      .replace(/```$/i, '')
      .trim();
    const start = cleaned.indexOf('[');
    const end = cleaned.lastIndexOf(']');
    const sliced = start >= 0 && end > start ? cleaned.slice(start, end + 1) : cleaned;
    const parsed = JSON.parse(sliced) as PrioritizationResult[];
    if (!Array.isArray(parsed) || parsed.length === 0) throw new Error('empty');
    return parsed;
  } catch (e) {
    console.warn('[ollama] prioritization parse failed — using rule fallback', e);
    return families.map((f) => computeRuleScore(f));
  }
}

// ---------- Family update — recompute score after distribution -----------

export async function recomputeAfterUpdate(
  family: Family,
  oldScore: number,
  changes: string,
  language: 'en' | 'ar' | 'fr' | 'es' = 'en'
): Promise<{ new_score: number; delta: number; reason: string }> {
  // Pull this family's distributions so the rule fallback can factor in
  // delivery history (recent successes lower the score, failures raise it).
  const dists = await db.distributions
    .where('family_id')
    .equals(family.family_id)
    .toArray();
  if (!(await pingOllama())) {
    const r = computeRuleScore(
      { ...family, last_aid_at: new Date().toISOString() },
      dists
    );
    return { new_score: r.priority_score, delta: r.priority_score - oldScore, reason: r.reason };
  }
  const langName =
    language === 'ar' ? 'Arabic' : language === 'fr' ? 'French' : language === 'es' ? 'Spanish' : 'English';
  const sys = `A humanitarian field worker has updated family #${family.family_id}'s status after an aid distribution. Previous priority score: ${oldScore}. Changes: ${changes}. Recalculate the priority score using the same rubric as before. Return strict JSON: {"new_score": <0-100>, "delta": <signed int>, "reason": "<1 sentence>"}. Respond in ${langName}.`;
  try {
    const raw = await chat(
      [
        { role: 'system', content: sys },
        { role: 'user', content: JSON.stringify(family) },
      ],
      { temperature: 0.2, maxTokens: 256 }
    );
    const cleaned = raw.replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    return JSON.parse(cleaned.slice(start, end + 1));
  } catch {
    const r = computeRuleScore(
      { ...family, last_aid_at: new Date().toISOString() },
      dists
    );
    return { new_score: r.priority_score, delta: r.priority_score - oldScore, reason: r.reason };
  }
}
