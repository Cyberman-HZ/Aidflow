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
import {
  executeReadTool,
  isWriteTool,
  parseToolArgs,
  type ToolCall,
  type ToolContext,
  type ToolDefinition,
} from './aiTools';

interface ChatResponse {
  message?: {
    role: string;
    content: string;
    /** Ollama's native tool-calling field, parallel to OpenAI's tool_calls. */
    tool_calls?: ToolCall[];
  };
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

/**
 * Run `fn(signal)` with a timeout. The signal is wired through to the
 * underlying fetch so that on timeout the network request is actually
 * cancelled — without this, the old `Promise.race(p, sleep(ms))` design
 * would reject the caller but leave the fetch running in the background.
 * A hung Ollama could then accumulate stuck fetches until the tab closed.
 */
async function withTimeout<T>(
  fn: (signal: AbortSignal) => Promise<T>,
  ms = 60_000
): Promise<T> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), ms);
  try {
    return await fn(ac.signal);
  } finally {
    clearTimeout(timer);
  }
}

// ---------- Health check --------------------------------------------------

export async function pingOllama(): Promise<boolean> {
  try {
    const { baseUrl } = getConfig();
    const r = await withTimeout(
      (signal) => fetch(`${baseUrl}/api/tags`, { method: 'GET', signal }),
      5_000
    );
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
  const res = await withTimeout((signal) =>
    fetch(`${baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal,
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
  // AbortController-backed safety net: if the model never emits any
  // tokens for a long stretch (Ollama crashed mid-stream, model loop,
  // network glitch on a flaky lab Wi-Fi), abort the read so the page
  // can fall back gracefully instead of spinning forever. Reset on each
  // delta — large generations are fine as long as SOMETHING comes
  // through every IDLE_TIMEOUT_MS.
  const ac = new AbortController();
  const IDLE_TIMEOUT_MS = 90_000;
  let idleTimer = setTimeout(() => ac.abort(), IDLE_TIMEOUT_MS);
  const res = await fetch(`${baseUrl}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: ac.signal,
  });
  if (!res.ok || !res.body) {
    clearTimeout(idleTimer);
    throw new Error(`Ollama stream failed: ${res.status}`);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
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
          if (delta) {
            // Refresh the idle timer on every delta we actually receive.
            clearTimeout(idleTimer);
            idleTimer = setTimeout(() => ac.abort(), IDLE_TIMEOUT_MS);
            yield delta;
          }
          if (obj.done) {
            clearTimeout(idleTimer);
            return;
          }
        } catch {
          // ignore non-JSON keep-alives
        }
      }
    }
  } finally {
    clearTimeout(idleTimer);
  }
}

// ---------- Multimodal chat (image + text) --------------------------------
//
// Gemma 4 is a vision-language model. Ollama's native /api/chat accepts an
// `images: [<base64>, …]` array on a single message — the model receives
// the image alongside the text prompt and produces text in response.
//
// We deliberately keep this as a SEPARATE entry point (rather than adding
// an optional `images` param to chat()) so callers can't accidentally ship
// a giant base64 payload through paths that expect short text-only
// completions — the multimodal model is much slower and we want the call
// site to be explicit.
//
// All caveats from chat() apply:
//   * Browser must be able to reach Ollama (OLLAMA_ORIGINS=*).
//   * The configured model must support vision. If it doesn't, the model
//     silently ignores the image and treats the prompt as text-only — the
//     caller is responsible for telling the user something useful when
//     the response is obviously wrong (no extracted rows, etc.).

interface ChatImageOpts extends ChatOpts {
  /** Override the model just for this multimodal call. */
  model?: string;
  /** Ask Ollama to constrain output to valid JSON via `format: "json"`. */
  jsonMode?: boolean;
}

export async function chatWithImage(
  messages: ChatMessage[],
  imagesBase64: string[],
  opts: ChatImageOpts = {}
): Promise<string> {
  if (!imagesBase64.length) {
    throw new Error('chatWithImage called with no images.');
  }
  const { baseUrl, model: defaultModel } = getConfig();
  const model = opts.model ?? defaultModel;

  // Per Ollama's contract, the `images` field hangs off the LAST user
  // message. We clone the array (rather than mutate the caller's input)
  // and attach the images to the final user turn — falling back to a
  // synthesized turn if the caller somehow handed us only a system msg.
  const conv = messages.map((m) => ({
    role: m.role,
    content: m.content,
  })) as Array<{ role: string; content: string; images?: string[] }>;
  const lastUserIdx = (() => {
    for (let i = conv.length - 1; i >= 0; i--) {
      if (conv[i].role === 'user') return i;
    }
    return -1;
  })();
  if (lastUserIdx >= 0) {
    conv[lastUserIdx].images = imagesBase64;
  } else {
    conv.push({ role: 'user', content: '', images: imagesBase64 });
  }

  const body: Record<string, unknown> = {
    model,
    messages: conv,
    stream: false,
    options: {
      num_ctx: opts.numCtx ?? DEFAULT_NUM_CTX,
      temperature: opts.temperature ?? 0.2,
      num_predict: opts.maxTokens ?? 2048,
    },
  };
  if (opts.jsonMode) body.format = 'json';

  // Vision inference is slow on a CPU — push the timeout out to 5 min so
  // a low-end field laptop has a chance to finish before we abort.
  const res = await withTimeout(
    (signal) =>
      fetch(`${baseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal,
      }),
    300_000
  );
  if (!res.ok) {
    throw new Error(`Ollama vision chat failed: ${res.status} ${res.statusText}`);
  }
  const data = (await res.json()) as ChatResponse;
  return data.message?.content ?? '';
}

// ---------- Embeddings (RAG) ----------------------------------------------

export async function embed(text: string): Promise<number[]> {
  const { baseUrl, embedModel } = getConfig();
  const res = await withTimeout(
    (signal) =>
      fetch(`${baseUrl}/api/embeddings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: embedModel, prompt: text }),
        signal,
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

// ---------- Tool calling (native function calling) ------------------------
//
// Gemma 4 supports native function calling. We pass a `tools` array to
// Ollama's /api/chat endpoint (OpenAI-compatible schema). The model can
// either reply with text OR with a `tool_calls` array. When tools are
// called we:
//
//   1. For READ tools — execute them automatically against IndexedDB,
//      append the result as a `role: "tool"` turn, and ask the model again
//      so it can synthesize a final natural-language answer.
//   2. For WRITE tools — DO NOT execute. We return them to the caller so
//      the AIChat component can render an Apply/Discard card. The model
//      gets a `{ "status": "proposed_to_user" }` tool response so it can
//      finish its sentence ("Drafted a dispatch for review.") without
//      thinking the write already happened.
//
// The loop bounds: at most 5 model rounds. This is enough for a query like
// "find critical WASH families and draft dispatches" (find_families →
// find_workers → N draft_dispatch_order calls) but small enough that a
// stuck model cannot burn the laptop's CPU.

export interface ToolMessage {
  role: 'tool';
  /** JSON-encoded payload returned by the tool. */
  content: string;
  /** Name of the tool that produced this payload (Ollama-native field). */
  tool_name?: string;
}

export interface AssistantToolMessage {
  role: 'assistant';
  content: string;
  tool_calls?: ToolCall[];
}

type ToolLoopMessage = ChatMessage | ToolMessage | AssistantToolMessage;

export interface ToolReadEvent {
  kind: 'read';
  name: string;
  args: Record<string, unknown>;
  result: unknown;
  error?: string;
}

export interface ToolWriteEvent {
  kind: 'write';
  call: ToolCall;
}

export type ToolEvent = ToolReadEvent | ToolWriteEvent;

export interface ChatWithToolsResult {
  /** The final assistant text (may be empty if the run ended on writes). */
  text: string;
  /** Every read tool that was auto-executed. */
  reads: ToolReadEvent[];
  /** Every write tool the model proposed (awaiting user confirmation). */
  writes: ToolWriteEvent[];
  /** True if the loop hit its step cap. */
  truncated: boolean;
}

const MAX_TOOL_STEPS = 5;

/**
 * Run a chat with function-calling enabled. Read tools are auto-executed;
 * write tools are returned to the caller so the UI can surface them as
 * Apply/Discard cards.
 */
export async function chatWithTools(
  messages: ChatMessage[],
  tools: ToolDefinition[],
  ctx: ToolContext,
  opts: ChatOpts = {}
): Promise<ChatWithToolsResult> {
  const { baseUrl, model } = getConfig();
  const convo: ToolLoopMessage[] = messages.map((m) => ({
    role: m.role,
    content: m.content,
  }));
  const reads: ToolReadEvent[] = [];
  const writes: ToolWriteEvent[] = [];
  let truncated = false;
  let finalText = '';

  for (let step = 0; step < MAX_TOOL_STEPS; step++) {
    const body = {
      model,
      messages: convo.map((m) => {
        // Strip undefineds so Ollama is happy.
        const out: Record<string, unknown> = { role: m.role, content: m.content };
        if ('tool_calls' in m && m.tool_calls) out.tool_calls = m.tool_calls;
        if ('tool_name' in m && m.tool_name) out.tool_name = m.tool_name;
        return out;
      }),
      tools,
      stream: false,
      options: {
        num_ctx: opts.numCtx ?? DEFAULT_NUM_CTX,
        temperature: opts.temperature ?? 0.3,
        num_predict: opts.maxTokens ?? 1024,
      },
    };

    const res = await withTimeout(
      (signal) =>
        fetch(`${baseUrl}/api/chat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal,
        }),
      120_000
    );
    if (!res.ok) {
      throw new Error(`Ollama chat (tools) failed: ${res.status} ${res.statusText}`);
    }
    const data = (await res.json()) as ChatResponse;
    const message = data.message;
    if (!message) {
      throw new Error('Ollama returned no message');
    }

    const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];

    // Record the assistant turn so subsequent tool responses are attached
    // to the right call. We always push it whether or not it has tool calls,
    // so the model sees its own prior reasoning in the next step.
    convo.push({
      role: 'assistant',
      content: message.content ?? '',
      tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
    });

    if (toolCalls.length === 0) {
      // No more tool calls — done.
      finalText = message.content ?? '';
      break;
    }

    // Partition: read calls run now; write calls bubble up.
    let didRead = false;
    for (const call of toolCalls) {
      const name = call.function?.name;
      if (!name) continue;
      const args = parseToolArgs(call);

      if (isWriteTool(name)) {
        writes.push({ kind: 'write', call });
        // Tell the model the write is in the user's hands so it stops
        // looping and doesn't pretend the change is already committed.
        convo.push({
          role: 'tool',
          content: JSON.stringify({ status: 'proposed_to_user' }),
          tool_name: name,
        });
      } else {
        didRead = true;
        try {
          const result = await executeReadTool(name, args, ctx);
          reads.push({ kind: 'read', name, args, result });
          convo.push({
            role: 'tool',
            content: JSON.stringify(result),
            tool_name: name,
          });
        } catch (e) {
          const err = e instanceof Error ? e.message : String(e);
          reads.push({ kind: 'read', name, args, result: null, error: err });
          convo.push({
            role: 'tool',
            content: JSON.stringify({ error: err }),
            tool_name: name,
          });
        }
      }
    }

    // If the model ONLY proposed writes (no reads to chew on), give it one
    // more turn so it can produce a confirmation sentence ("Drafted N
    // dispatches — please review."). If didRead is true, we always loop
    // again so the model sees the read results.
    if (!didRead) {
      // One more pass so it can summarize the writes it proposed.
      // Falls through to next step iteration.
    }

    if (step === MAX_TOOL_STEPS - 1) {
      truncated = true;
      // Final text is whatever the last assistant content was.
      finalText = message.content ?? finalText;
    }
  }

  return { text: finalText, reads, writes, truncated };
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
