// AidFlow Pro — AI audit log browser.
//
// Reads from the aiTraces table populated by every AI invocation in the
// app. Shows newest-first, filterable by source, full-text searchable,
// and exposes the same TracePanel the inline Trace buttons use so a
// donor / auditor can spot-check any decision the model has made.
//
// All data is local — never leaves the device.

import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ShieldCheck,
  Trash2,
  Download,
  Search,
  AlertTriangle,
  CheckCircle2,
  Wrench,
  BookOpen,
  Sparkles,
} from 'lucide-react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '@/db/database';
import { Card } from '@/components/Card';
import EmptyState from '@/components/EmptyState';
import TraceButton from '@/components/TraceButton';
import {
  clearAllTraces,
  purgeOlderThan,
  sourceLabel,
  exportTraceAsJson,
} from '@/services/aiTrace';
import type { AiTrace, AiTraceSource } from '@/types';

const SOURCES: ReadonlyArray<AiTraceSource | 'ALL'> = [
  'ALL',
  'chat_tools',
  'chat_rag',
  'chat_plain',
  'family_chat_scoped',
  'dashboard_summary',
  'priority_rank',
  'paper_form',
  'spreadsheet_map',
  'kids_content',
];

export default function AiAudit() {
  const { t } = useTranslation();
  const [source, setSource] = useState<AiTraceSource | 'ALL'>('ALL');
  const [search, setSearch] = useState('');

  // Live query — refreshes the list automatically as new traces land.
  const traces = useLiveQuery(
    () => db.aiTraces.orderBy('created_at').reverse().limit(500).toArray(),
    []
  );

  const filtered = useMemo(() => {
    if (!traces) return [];
    let rows = traces;
    if (source !== 'ALL') rows = rows.filter((t) => t.source === source);
    if (search.trim()) {
      const needle = search.trim().toLowerCase();
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
  }, [traces, source, search]);

  const onClearAll = async () => {
    if (
      !confirm(
        t(
          'audit.confirm_clear',
          'Permanently delete every AI trace? This cannot be undone.'
        ) as string
      )
    )
      return;
    await clearAllTraces();
  };

  const onPurgeOld = async () => {
    const n = await purgeOlderThan(30);
    alert(t('audit.purged_n', { count: n, defaultValue: `Purged ${n} trace(s) older than 30 days.` }) as string);
  };

  const onExportAll = () => {
    if (!filtered.length) return;
    const blob = new Blob([JSON.stringify(filtered, null, 2)], {
      type: 'application/json',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `aidflow-audit-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  };

  return (
    <div className="space-y-5">
      <header>
        <h1 className="text-2xl font-bold flex items-center gap-2">
          <ShieldCheck size={22} className="text-ai" />
          {t('audit.title', 'AI audit log')}
        </h1>
        <p className="text-sm text-slate-400 mt-1">
          {t(
            'audit.subtitle',
            'Every AI invocation in AidFlow Pro is recorded here — the data the model saw, the tools it ran, the citations it used, and the response it produced. All local to this device.'
          )}
        </p>
      </header>

      {/* Controls */}
      <Card>
        <div className="flex flex-wrap items-center gap-3">
          <div className="relative flex-1 min-w-[180px]">
            <Search
              size={14}
              className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-500"
            />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={
                t(
                  'audit.search_placeholder',
                  'Search prompts, responses, errors…'
                ) as string
              }
              className="w-full bg-surface-deep border border-slate-700 rounded-md pl-8 pr-2 py-1.5 text-sm focus:border-brand outline-none"
            />
          </div>
          <select
            value={source}
            onChange={(e) => setSource(e.target.value as AiTraceSource | 'ALL')}
            className="bg-surface-deep border border-slate-700 rounded-md px-2 py-1.5 text-sm focus:border-brand outline-none"
          >
            {SOURCES.map((s) => (
              <option key={s} value={s}>
                {s === 'ALL' ? t('audit.all_sources', 'All sources') : sourceLabel(s)}
              </option>
            ))}
          </select>
          <button
            onClick={onExportAll}
            disabled={!filtered.length}
            className="touch-target px-3 py-1.5 bg-surface-light hover:bg-slate-600 disabled:opacity-50 rounded-md text-xs flex items-center gap-1 font-semibold"
          >
            <Download size={12} />
            {t('audit.export_all', 'Export filtered as JSON')}
          </button>
          <button
            onClick={() => void onPurgeOld()}
            className="touch-target px-3 py-1.5 text-xs text-slate-400 hover:text-slate-100"
          >
            {t('audit.purge_old', 'Purge >30 days')}
          </button>
          <button
            onClick={() => void onClearAll()}
            className="touch-target px-3 py-1.5 text-xs text-priority-critical hover:underline flex items-center gap-1"
          >
            <Trash2 size={12} />
            {t('audit.clear_all', 'Clear all')}
          </button>
        </div>
        <p className="text-xs text-slate-500 mt-3">
          {t('audit.count', {
            count: filtered.length,
            total: traces?.length ?? 0,
            defaultValue: `${filtered.length} of ${traces?.length ?? 0} traces shown.`,
          })}
        </p>
      </Card>

      {/* Empty state */}
      {traces && traces.length === 0 && (
        <EmptyState
          icon={<ShieldCheck size={36} />}
          title={t('audit.empty_title', 'No AI traces yet')}
          body={t(
            'audit.empty_body',
            'Ask the assistant a question, run the priority re-ranker, generate an executive summary, or import a paper form — every AI invocation will appear here for inspection.'
          )}
        />
      )}

      {/* Trace list */}
      {filtered.length > 0 && (
        <Card>
          <ul className="divide-y divide-slate-700">
            {filtered.map((tr) => (
              <TraceRow key={tr.trace_id} trace={tr} />
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}

// =========================================================================
// One row per trace
// =========================================================================

function TraceRow({ trace }: { trace: AiTrace }) {
  const { t } = useTranslation();

  const readCount = trace.tool_reads?.length ?? 0;
  const writeCount = trace.tool_writes?.length ?? 0;
  const citationCount = trace.citations?.length ?? 0;
  const hasError = !!trace.error;
  const isFallback = !!trace.fallback_used;

  return (
    <li className="py-3 flex items-start gap-3">
      <div className="flex-shrink-0 mt-1">
        {hasError ? (
          <AlertTriangle size={16} className="text-priority-critical" />
        ) : isFallback ? (
          <AlertTriangle size={16} className="text-priority-medium" />
        ) : (
          <CheckCircle2 size={16} className="text-priority-normal" />
        )}
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-sm font-semibold text-slate-200">
            {sourceLabel(trace.source)}
          </span>
          <span className="text-[10px] text-slate-500">
            {new Date(trace.created_at).toLocaleString()}
          </span>
          {typeof trace.duration_ms === 'number' && (
            <span className="text-[10px] text-slate-500">
              · {(trace.duration_ms / 1000).toFixed(2)}s
            </span>
          )}
          {isFallback && (
            <span className="text-[10px] bg-priority-medium/15 text-priority-medium border border-priority-medium/30 px-1.5 py-0.5 rounded-full">
              {t('audit.tag_fallback', 'fallback')}
            </span>
          )}
          {hasError && (
            <span className="text-[10px] bg-priority-critical/15 text-priority-critical border border-priority-critical/30 px-1.5 py-0.5 rounded-full">
              {t('audit.tag_error', 'error')}
            </span>
          )}
        </div>
        <div className="text-xs text-slate-400 mt-0.5">{trace.inputs_summary}</div>
        {trace.user_input && (
          <div className="text-xs text-slate-500 italic mt-0.5 line-clamp-1">
            "{trace.user_input}"
          </div>
        )}
        <div className="flex items-center gap-3 mt-1.5 text-[11px] text-slate-500">
          {readCount > 0 && (
            <span className="inline-flex items-center gap-1">
              <Wrench size={10} /> {readCount} {t('audit.reads', 'reads')}
            </span>
          )}
          {writeCount > 0 && (
            <span className="inline-flex items-center gap-1">
              <Sparkles size={10} /> {writeCount} {t('audit.writes', 'writes')}
            </span>
          )}
          {citationCount > 0 && (
            <span className="inline-flex items-center gap-1">
              <BookOpen size={10} /> {citationCount} {t('audit.citations', 'citations')}
            </span>
          )}
        </div>
      </div>
      <div className="flex items-center gap-1 flex-shrink-0">
        <TraceButton
          traceId={trace.trace_id}
          variant="badge"
          label={t('audit.view_trace', 'view')}
        />
        <button
          onClick={() => exportTraceAsJson(trace)}
          title={t('audit.export_one', 'Export this trace')}
          className="touch-target p-1.5 text-slate-500 hover:text-slate-100"
        >
          <Download size={12} />
        </button>
      </div>
    </li>
  );
}
