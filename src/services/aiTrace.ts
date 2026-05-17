// AidFlow Pro — AI trace log (explainable-AI audit trail).
//
// Every Gemma 4 invocation in the app writes a trace row capturing what
// data the model saw, which tools it ran, what citations it used,
// whether the rule-engine fallback took over, and the final response.
//
// The Trace button on each AI output reads these rows; the /audit page
// browses them. Everything stays in IndexedDB — pure local provenance,
// never sent anywhere.
//
// Design notes:
//   * recordTrace is fire-and-forget from the caller's perspective: it
//     awaits the DB write but the caller can swallow errors so an audit
//     failure NEVER breaks an AI feature for the user. The whole point
//     is "the AI still works without this; the trace is gravy".
//   * tool results are stored as compact JSON STRINGS (result_summary),
//     not raw objects, so an arbitrarily large family list doesn't blow
//     up the trace row. We truncate at a generous-but-safe ceiling.

import { db } from '@/db/database';
import type {
  AiTrace,
  AiTraceCitation,
  AiTraceSource,
  AiTraceToolRead,
  AiTraceToolWrite,
} from '@/types';

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

/** Each tool-result JSON gets clipped at this length to keep traces lean. */
const RESULT_SUMMARY_MAX = 4_000;

/** Auto-purge horizon — older traces removed when purgeOlderThan is called. */
const DEFAULT_PURGE_DAYS = 30;

// ---------------------------------------------------------------------------
// Public types — caller-side input shape (everything optional except source)
// ---------------------------------------------------------------------------

export interface RecordTraceOpts {
  source: AiTraceSource;
  language?: string;
  model?: string;
  inputs_summary?: string;
  system_prompt?: string;
  user_input?: string;
  tool_reads?: AiTraceToolRead[];
  tool_writes?: AiTraceToolWrite[];
  citations?: AiTraceCitation[];
  fallback_used?: boolean;
  fallback_reason?: string;
  response_text?: string;
  error?: string;
  duration_ms?: number;
  metadata?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Truncate a string to maxLen with a clear "[truncated]" marker. Used so
 * a 100 KB tool result doesn't bloat a single trace row beyond what the
 * UI can render.
 */
export function clip(s: string, maxLen = RESULT_SUMMARY_MAX): string {
  if (s.length <= maxLen) return s;
  return `${s.slice(0, maxLen)}… [truncated ${s.length - maxLen} chars]`;
}

/**
 * Stringify an arbitrary tool result into a clipped JSON snippet. Handles
 * cycles by falling back to String() on failure.
 */
export function summarizeToolResult(result: unknown): string {
  try {
    return clip(JSON.stringify(result, null, 2));
  } catch {
    return clip(String(result));
  }
}

function newTraceId(): string {
  return `T-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Persist one AI trace row and return its id. The caller can attach the
 * id to the corresponding AI output (e.g. a ChatMessage.trace_id field)
 * so the Trace button can look it up later.
 *
 * Never throws — if the DB write fails, returns a synthetic id and logs
 * a warning, so an audit-log failure cannot break the AI feature itself.
 */
export async function recordTrace(opts: RecordTraceOpts): Promise<string> {
  const trace_id = newTraceId();
  const row: AiTrace = {
    trace_id,
    source: opts.source,
    created_at: new Date().toISOString(),
    duration_ms: opts.duration_ms,
    language: opts.language ?? 'en',
    model: opts.model ?? 'gemma4:e4b',
    inputs_summary: opts.inputs_summary ?? '',
    system_prompt: opts.system_prompt,
    user_input: opts.user_input,
    tool_reads: opts.tool_reads,
    tool_writes: opts.tool_writes,
    citations: opts.citations,
    fallback_used: opts.fallback_used,
    fallback_reason: opts.fallback_reason,
    response_text: opts.response_text,
    error: opts.error,
    metadata: opts.metadata,
  };
  try {
    await db.aiTraces.put(row);
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn('[aiTrace] failed to persist trace', e, row);
  }
  return trace_id;
}

export async function getTrace(trace_id: string): Promise<AiTrace | undefined> {
  return await db.aiTraces.get(trace_id);
}

/**
 * Update fields on an existing trace. Used to mark write-tool statuses
 * (Applied / Discarded / Failed) after the user clicks the card.
 */
export async function patchTrace(
  trace_id: string,
  patch: Partial<AiTrace>
): Promise<void> {
  try {
    await db.aiTraces.update(trace_id, patch);
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn('[aiTrace] patch failed', e);
  }
}

export interface ListTracesOpts {
  source?: AiTraceSource;
  limit?: number;
  search?: string;
}

export async function listTraces(opts: ListTracesOpts = {}): Promise<AiTrace[]> {
  const limit = opts.limit ?? 200;
  let coll = db.aiTraces.orderBy('created_at').reverse();
  if (opts.source) coll = coll.filter((t) => t.source === opts.source);
  let rows = await coll.limit(limit).toArray();
  if (opts.search) {
    const needle = opts.search.toLowerCase();
    rows = rows.filter((t) => {
      const hay = [
        t.inputs_summary,
        t.user_input,
        t.response_text,
        t.system_prompt,
        t.fallback_reason,
        t.error,
      ]
        .filter(Boolean)
        .join('\n')
        .toLowerCase();
      return hay.includes(needle);
    });
  }
  return rows;
}

export async function deleteTrace(trace_id: string): Promise<void> {
  await db.aiTraces.delete(trace_id);
}

export async function clearAllTraces(): Promise<void> {
  await db.aiTraces.clear();
}

/**
 * Purge traces older than N days. Returns the count removed. Safe to
 * call on app boot or from a Settings action.
 */
export async function purgeOlderThan(days = DEFAULT_PURGE_DAYS): Promise<number> {
  const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
  const stale = await db.aiTraces.where('created_at').below(cutoff).toArray();
  await db.aiTraces.bulkDelete(stale.map((t) => t.trace_id));
  return stale.length;
}

/**
 * Friendly label for a source — used by the UI and the JSON export.
 */
export function sourceLabel(s: AiTraceSource): string {
  switch (s) {
    case 'chat_tools':
      return 'Assistant · function calling';
    case 'chat_rag':
      return 'Assistant · RAG (PDF knowledge base)';
    case 'chat_plain':
      return 'Assistant · plain chat';
    case 'family_chat_scoped':
      return 'Family chat (scoped)';
    case 'dashboard_summary':
      return 'Dashboard executive summary';
    case 'priority_rank':
      return 'Priority triage (batch)';
    case 'paper_form':
      return 'Paper-form vision ingest';
    case 'spreadsheet_map':
      return 'Spreadsheet column mapping';
    case 'kids_content':
      return 'Emotional-support content';
    default:
      return s;
  }
}

/**
 * Export a single trace as a downloadable JSON file. Useful for donor
 * audit packs — the auditor can replay the model's exact decision
 * inputs and outputs without needing access to the live app.
 */
export function exportTraceAsJson(trace: AiTrace): void {
  const blob = new Blob([JSON.stringify(trace, null, 2)], {
    type: 'application/json',
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${trace.trace_id}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
