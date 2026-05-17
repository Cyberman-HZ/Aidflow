// AidFlow Pro — Trace button (explainable-AI viewer).
//
// Renders a small "why?" link next to any AI-generated output. Clicking
// it opens a side panel showing exactly what data the model saw, which
// tools ran, what citations it used, whether the rule-engine fallback
// took over, and the final response. Everything reads from the local
// aiTraces table — pure provenance, never leaves the device.
//
// Discovery hint: until the user clicks ANY trace button (or dismisses
// the bubble), the first visible button on screen shows a small floating
// speech bubble pointing at it explaining the feature, plus a pulsing
// notification dot. Dismissal is per-device (localStorage) so returning
// users don't see it again.

import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Info,
  X,
  Sparkles,
  Wrench,
  ShieldCheck,
  AlertTriangle,
  BookOpen,
  Download,
  Clock,
  Cpu,
} from 'lucide-react';
import type { AiTrace } from '@/types';
import { getTrace, sourceLabel, exportTraceAsJson } from '@/services/aiTrace';

// =========================================================================
// Discovery hint state — module-level so only the FIRST TraceButton to
// mount on a given page shows the bubble (avoids visual noise when an
// assistant reply contains several outputs each with their own button).
// =========================================================================

const STORAGE_KEY = 'aidflow.trace_discovery_dismissed';

/** True once the user has clicked any trace button or dismissed the bubble. */
function getDiscoveryDismissed(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

function setDiscoveryDismissed() {
  try {
    localStorage.setItem(STORAGE_KEY, '1');
  } catch {
    /* private mode / quota — silently no-op, hint just stays visible */
  }
}

// Per-page-load guard so only the first un-dismissed trace button claims
// the bubble. Reset implicitly when the page reloads.
let bubbleClaimedThisPage = false;
// Subscribers so when one button dismisses, sibling buttons drop their
// notification dots too. Tiny pub/sub avoids dragging in a store.
const dismissSubscribers = new Set<() => void>();
function notifyDismissed() {
  for (const fn of dismissSubscribers) fn();
}

// =========================================================================
// TraceButton — the inline "why?" affordance + discovery hint
// =========================================================================

export default function TraceButton({
  traceId,
  variant = 'inline',
  label,
}: {
  traceId: string | undefined;
  variant?: 'inline' | 'badge';
  label?: string;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  // Local mirror of the discovery state. We initialise from localStorage
  // but ALSO subscribe to sibling-button dismissals so the dot disappears
  // everywhere on first interaction.
  const [dismissed, setDismissedLocal] = useState<boolean>(() => getDiscoveryDismissed());
  const [showBubble, setShowBubble] = useState(false);

  // Claim the bubble for this button if we're the first un-dismissed one
  // on the page. Done in an effect so SSR / first-render is stable.
  useEffect(() => {
    if (!traceId) return;
    if (!dismissed && !bubbleClaimedThisPage) {
      bubbleClaimedThisPage = true;
      setShowBubble(true);
    }
  }, [traceId, dismissed]);

  // Sibling dismissals propagate via the pub/sub set.
  useEffect(() => {
    const onDismiss = () => {
      setDismissedLocal(true);
      setShowBubble(false);
    };
    dismissSubscribers.add(onDismiss);
    return () => {
      dismissSubscribers.delete(onDismiss);
    };
  }, []);

  if (!traceId) return null;

  const dismissDiscovery = () => {
    setDiscoveryDismissed();
    setDismissedLocal(true);
    setShowBubble(false);
    notifyDismissed();
  };

  const onClick = () => {
    // Opening the panel also counts as discovery — quietly dismiss.
    if (!dismissed) dismissDiscovery();
    setOpen(true);
  };

  const cls =
    variant === 'badge'
      ? 'inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded-full border border-ai/30 text-ai bg-ai/10 hover:bg-ai/20 relative'
      : 'inline-flex items-center gap-1 text-[10px] text-slate-500 hover:text-ai italic relative';

  // When undiscovered, swap the muted "why?" for a clearer call-to-action
  // and bump the visual emphasis. After dismissal, the button returns to
  // its quiet default so it doesn't compete with normal content.
  const displayLabel =
    label ?? (dismissed ? t('trace.button', 'why?') : t('trace.button_new', 'How did I decide?'));

  return (
    <span className="relative inline-flex">
      <button
        type="button"
        onClick={onClick}
        title={t(
          'trace.tooltip',
          'Trace — show what data the AI saw and how it responded'
        )}
        className={cls}
      >
        <Info size={11} />
        {displayLabel}
        {/* Pulsing notification dot — only while undiscovered. */}
        {!dismissed && (
          <span className="absolute -top-0.5 -right-0.5 inline-flex h-2 w-2">
            <span className="absolute inline-flex h-full w-full rounded-full bg-ai opacity-75 animate-ping" />
            <span className="relative inline-flex rounded-full h-2 w-2 bg-ai" />
          </span>
        )}
      </button>

      {showBubble && !dismissed && <DiscoveryBubble onDismiss={dismissDiscovery} />}
      {open && <TracePanel traceId={traceId} onClose={() => setOpen(false)} />}
    </span>
  );
}

// =========================================================================
// DiscoveryBubble — floating speech bubble pointing at the trace button
// =========================================================================

function DiscoveryBubble({ onDismiss }: { onDismiss: () => void }) {
  const { t } = useTranslation();
  return (
    <div
      role="dialog"
      aria-label={t('trace.discovery_title', 'Explainable AI — new feature')}
      className="absolute top-full mt-2 right-0 z-30 w-64"
    >
      {/* Arrow pointing back up to the button. Built from a rotated square
          so it inherits the bubble's border + background colour. */}
      <span
        aria-hidden
        className="absolute -top-1.5 right-4 w-3 h-3 bg-ai border-l border-t border-ai rotate-45"
      />
      <div className="relative bg-ai text-white rounded-lg shadow-2xl shadow-ai/30 p-3 text-xs">
        <button
          type="button"
          onClick={onDismiss}
          aria-label={t('trace.discovery_dismiss', 'Dismiss')}
          className="absolute top-1.5 right-1.5 text-white/70 hover:text-white p-0.5"
        >
          <X size={12} />
        </button>
        <div className="flex items-start gap-2 pr-4">
          <Sparkles size={14} className="flex-shrink-0 mt-0.5" />
          <div className="flex-1 leading-snug">
            <div className="font-semibold mb-1">
              {t('trace.discovery_title', 'New — explainable AI')}
            </div>
            <p className="text-white/90">
              {t(
                'trace.discovery_body',
                'Click to see the exact data, tools, and citations behind every AI output. Everything stays on your device.'
              )}
            </p>
            <button
              type="button"
              onClick={onDismiss}
              className="mt-2 text-[10px] uppercase tracking-wider font-semibold underline hover:no-underline"
            >
              {t('trace.discovery_got_it', 'Got it')}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// =========================================================================
// TracePanel — the sliding side panel
// =========================================================================

function TracePanel({
  traceId,
  onClose,
}: {
  traceId: string;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [trace, setTrace] = useState<AiTrace | null | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    void getTrace(traceId).then((tr) => {
      if (!cancelled) setTrace(tr ?? null);
    });
    return () => {
      cancelled = true;
    };
  }, [traceId]);

  // Close on Escape.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={t('trace.panel_title', 'AI decision trace')}
      className="fixed inset-0 z-50 bg-black/60 flex justify-end"
      onClick={onClose}
    >
      <div
        className="w-full max-w-2xl bg-surface border-l border-slate-700 shadow-2xl overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="sticky top-0 z-10 bg-surface border-b border-slate-700 px-5 py-3 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 min-w-0">
            <ShieldCheck size={18} className="text-ai flex-shrink-0" />
            <h2 className="font-semibold truncate">
              {t('trace.panel_title', 'AI decision trace')}
            </h2>
          </div>
          <div className="flex items-center gap-1.5">
            {trace && (
              <button
                onClick={() => exportTraceAsJson(trace)}
                title={t('trace.export', 'Export as JSON')}
                className="touch-target p-1.5 hover:bg-surface-light rounded text-slate-400 hover:text-slate-100"
              >
                <Download size={14} />
              </button>
            )}
            <button
              onClick={onClose}
              aria-label={t('common.close', 'Close')}
              className="touch-target p-1.5 hover:bg-surface-light rounded text-slate-400 hover:text-slate-100"
            >
              <X size={16} />
            </button>
          </div>
        </header>

        <div className="p-5 space-y-5">
          {trace === undefined && (
            <p className="text-sm text-slate-400 italic">
              {t('trace.loading', 'Loading trace…')}
            </p>
          )}
          {trace === null && (
            <p className="text-sm text-priority-medium">
              {t(
                'trace.not_found',
                "Trace not found. It may have been purged from the audit log."
              )}
            </p>
          )}
          {trace && <TraceBody trace={trace} />}
        </div>
      </div>
    </div>
  );
}

// =========================================================================
// TraceBody — render every section that's present on the trace
// =========================================================================

function TraceBody({ trace }: { trace: AiTrace }) {
  const { t } = useTranslation();

  return (
    <>
      {/* Header strip — source, model, time, duration */}
      <section className="space-y-2">
        <div className="text-xs uppercase tracking-wider text-ai font-semibold">
          {t('trace.section_overview', 'Overview')}
        </div>
        <div className="text-sm text-slate-200 font-semibold">
          {sourceLabel(trace.source)}
        </div>
        <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-slate-400">
          <KV
            icon={<Cpu size={11} />}
            k={t('trace.kv_model', 'Model')}
            v={trace.model}
          />
          <KV
            icon={<Clock size={11} />}
            k={t('trace.kv_when', 'When')}
            v={new Date(trace.created_at).toLocaleString()}
          />
          <KV
            k={t('trace.kv_language', 'Language')}
            v={trace.language.toUpperCase()}
          />
          {typeof trace.duration_ms === 'number' && (
            <KV
              k={t('trace.kv_duration', 'Duration')}
              v={`${(trace.duration_ms / 1000).toFixed(2)} s`}
            />
          )}
          <KV
            k={t('trace.kv_trace_id', 'Trace ID')}
            v={<code className="text-[11px]">{trace.trace_id}</code>}
          />
        </div>
        {trace.inputs_summary && (
          <p className="text-xs text-slate-300 mt-2">{trace.inputs_summary}</p>
        )}
      </section>

      {/* Fallback banner — surfaces when rule-engine took over */}
      {trace.fallback_used && (
        <section className="bg-priority-medium/10 border border-priority-medium/30 rounded-lg p-3 flex items-start gap-2 text-xs text-priority-medium">
          <AlertTriangle size={14} className="flex-shrink-0 mt-0.5" />
          <div>
            <div className="font-semibold">
              {t('trace.fallback_banner', 'Rule-engine fallback used')}
            </div>
            {trace.fallback_reason && (
              <div className="text-slate-300 mt-0.5">{trace.fallback_reason}</div>
            )}
          </div>
        </section>
      )}

      {/* Error banner */}
      {trace.error && (
        <section className="bg-priority-critical/10 border border-priority-critical/30 rounded-lg p-3 flex items-start gap-2 text-xs text-priority-critical">
          <AlertTriangle size={14} className="flex-shrink-0 mt-0.5" />
          <div>
            <div className="font-semibold">{t('trace.error_banner', 'Error')}</div>
            <div className="text-slate-300 mt-0.5">{trace.error}</div>
          </div>
        </section>
      )}

      {/* User input */}
      {trace.user_input && (
        <Section title={t('trace.section_user', 'User input')}>
          <Pre>{trace.user_input}</Pre>
        </Section>
      )}

      {/* System prompt */}
      {trace.system_prompt && (
        <Section title={t('trace.section_system', 'System prompt sent to the model')}>
          <Pre>{trace.system_prompt}</Pre>
        </Section>
      )}

      {/* Tool reads — auto-executed */}
      {trace.tool_reads && trace.tool_reads.length > 0 && (
        <Section
          title={t('trace.section_reads', 'Read tools auto-executed')}
          icon={<Wrench size={12} className="text-ai" />}
        >
          <ul className="space-y-2">
            {trace.tool_reads.map((r, i) => (
              <li
                key={i}
                className="border border-slate-700 rounded-lg p-2.5 bg-surface-light/30 text-xs space-y-1.5"
              >
                <div className="flex items-center gap-2 font-mono">
                  <code className="text-ai">{r.name}</code>
                  {r.error && (
                    <span className="text-priority-critical text-[10px]">
                      ✗ {r.error}
                    </span>
                  )}
                </div>
                <details>
                  <summary className="text-[11px] text-slate-400 cursor-pointer hover:text-slate-200">
                    {t('trace.args_label', 'args')}
                  </summary>
                  <Pre small>{JSON.stringify(r.args, null, 2)}</Pre>
                </details>
                <details open>
                  <summary className="text-[11px] text-slate-400 cursor-pointer hover:text-slate-200">
                    {t('trace.result_label', 'result')}
                  </summary>
                  <Pre small>{r.result_summary}</Pre>
                </details>
              </li>
            ))}
          </ul>
        </Section>
      )}

      {/* Tool writes — proposed to user */}
      {trace.tool_writes && trace.tool_writes.length > 0 && (
        <Section
          title={t('trace.section_writes', 'Write proposals (Apply / Discard)')}
          icon={<Sparkles size={12} className="text-ai" />}
        >
          <ul className="space-y-2">
            {trace.tool_writes.map((w, i) => (
              <li
                key={i}
                className="border border-slate-700 rounded-lg p-2.5 bg-surface-light/30 text-xs space-y-1.5"
              >
                <div className="flex items-center justify-between gap-2">
                  <code className="text-ai font-mono">{w.name}</code>
                  {w.status && <StatusBadge status={w.status} />}
                </div>
                <div className="text-slate-300">{w.description}</div>
                <details>
                  <summary className="text-[11px] text-slate-400 cursor-pointer hover:text-slate-200">
                    {t('trace.args_label', 'args')}
                  </summary>
                  <Pre small>{JSON.stringify(w.args, null, 2)}</Pre>
                </details>
              </li>
            ))}
          </ul>
        </Section>
      )}

      {/* Citations */}
      {trace.citations && trace.citations.length > 0 && (
        <Section
          title={t('trace.section_citations', 'Citations (PDF chunks scored)')}
          icon={<BookOpen size={12} className="text-ai" />}
        >
          <ul className="space-y-2">
            {trace.citations.map((c, i) => (
              <li
                key={i}
                className="border border-slate-700 rounded-lg p-2.5 bg-surface-light/30 text-xs space-y-1"
              >
                <div className="flex items-center justify-between gap-2 flex-wrap">
                  <span className="font-semibold text-slate-200 truncate">
                    {c.doc_title}
                  </span>
                  <span className="text-slate-400 text-[11px]">
                    {typeof c.page === 'number' ? `p. ${c.page}` : ''}{' '}
                    {typeof c.score === 'number'
                      ? `· ${c.scoreKind ?? 'score'} ${c.score.toFixed(3)}`
                      : ''}
                  </span>
                </div>
                {c.excerpt && (
                  <p className="text-slate-400 italic leading-snug">"{c.excerpt}"</p>
                )}
              </li>
            ))}
          </ul>
        </Section>
      )}

      {/* Response */}
      {trace.response_text && (
        <Section title={t('trace.section_response', 'Model response')}>
          <Pre>{trace.response_text}</Pre>
        </Section>
      )}

      {/* Metadata */}
      {trace.metadata && Object.keys(trace.metadata).length > 0 && (
        <Section title={t('trace.section_metadata', 'Metadata')}>
          <Pre small>{JSON.stringify(trace.metadata, null, 2)}</Pre>
        </Section>
      )}
    </>
  );
}

// =========================================================================
// Small presentational helpers
// =========================================================================

function Section({
  title,
  icon,
  children,
}: {
  title: string;
  icon?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-2">
      <div className="text-xs uppercase tracking-wider text-ai font-semibold flex items-center gap-1.5">
        {icon}
        {title}
      </div>
      {children}
    </section>
  );
}

function KV({
  icon,
  k,
  v,
}: {
  icon?: React.ReactNode;
  k: string;
  v: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-1.5 min-w-0">
      {icon}
      <span className="text-slate-500">{k}:</span>
      <span className="text-slate-300 truncate">{v}</span>
    </div>
  );
}

function Pre({ children, small = false }: { children: React.ReactNode; small?: boolean }) {
  return (
    <pre
      className={`whitespace-pre-wrap break-words bg-surface-deep border border-slate-700 rounded p-2 text-slate-300 overflow-x-auto ${
        small ? 'text-[10px] leading-snug' : 'text-[11px] leading-relaxed'
      }`}
    >
      {children}
    </pre>
  );
}

function StatusBadge({ status }: { status: NonNullable<AiTrace['tool_writes']>[number]['status'] }) {
  const palette: Record<string, string> = {
    pending: 'border-slate-600 text-slate-400 bg-slate-700/30',
    applied: 'border-priority-normal/40 text-priority-normal bg-priority-normal/10',
    discarded: 'border-slate-600 text-slate-500 bg-slate-700/20',
    failed: 'border-priority-critical/40 text-priority-critical bg-priority-critical/10',
  };
  const cls = palette[status ?? 'pending'] ?? palette.pending;
  return (
    <span className={`text-[10px] font-semibold uppercase tracking-wider px-1.5 py-0.5 rounded-full border ${cls}`}>
      {status}
    </span>
  );
}
