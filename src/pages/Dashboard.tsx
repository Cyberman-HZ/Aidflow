// Dashboard & Reports — merged page.
// Combines the live KPIs/recent-distributions view with the historical charts,
// CSV export, and AI executive summary that used to live on /reports.

import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { useLiveQuery } from 'dexie-react-hooks';
import {
  Users,
  Package,
  AlertTriangle,
  Sparkles,
  TrendingUp,
  Activity,
  Download,
  BarChart3,
  RefreshCw,
  WifiOff,
} from 'lucide-react';
import {
  PieChart,
  Pie,
  Cell,
  Tooltip,
  Legend,
  ResponsiveContainer,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  LineChart,
  Line,
} from 'recharts';
import { Card, StatCard } from '@/components/Card';
import PriorityBadge, { levelFromScore } from '@/components/PriorityBadge';
import Loading from '@/components/Loading';
import { db } from '@/db/database';
import { useConnectivityStore } from '@/stores/connectivityStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { computeRuleScore } from '@/services/priorityRules';
import { chatStream, pingOllama } from '@/services/ollama';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

const PRIORITY_COLORS = {
  CRITICAL: '#ef4444',
  HIGH: '#f97316',
  MEDIUM: '#eab308',
  NORMAL: '#22c55e',
};

export default function Dashboard() {
  const { t } = useTranslation();
  const conn = useConnectivityStore();
  const language = useSettingsStore((s) => s.language);

  // Live queries — react to any DB change so the dashboard always reflects
  // current state (and the AI summary, when generated, uses the latest data).
  const families = useLiveQuery(() => db.families.toArray(), []) ?? [];
  const distributions = useLiveQuery(() => db.distributions.toArray(), []) ?? [];
  const workers = useLiveQuery(() => db.workers.toArray(), []) ?? [];

  const [summary, setSummary] = useState('');
  const [summaryError, setSummaryError] = useState<string | null>(null);
  const [summarySource, setSummarySource] = useState<'ai' | 'rules' | null>(null);
  const [generating, setGenerating] = useState(false);

  // ---- Derived data --------------------------------------------------------
  const today = new Date().toISOString().slice(0, 10);
  const todayDistros = distributions.filter(
    (d) =>
      d.status === 'delivered' &&
      (d.delivered_at ?? d.created_at ?? '').slice(0, 10) === today
  );
  const totalItemsToday = todayDistros.reduce(
    (sum, d) => sum + d.items_distributed.reduce((s, it) => s + it.quantity, 0),
    0
  );
  const activeOrders = distributions.filter(
    (d) => d.status === 'pending' || d.status === 'out_for_delivery'
  ).length;

  const scored = useMemo(
    () =>
      families.map((f) => ({
        ...f,
        score: f.priority_score ?? computeRuleScore(f).priority_score,
        level: f.priority_level ?? computeRuleScore(f).priority_level,
      })),
    [families]
  );
  const criticalCount = scored.filter((f) => f.score >= 80).length;

  const priorityDist = (['CRITICAL', 'HIGH', 'MEDIUM', 'NORMAL'] as const).map((lvl) => ({
    name: t(`priority.${lvl}`),
    level: lvl,
    value: scored.filter((f) => f.level === lvl).length,
  }));

  // Distributions per sector (bar) — only count delivered, not pending/cancelled
  const sectorData = useMemo(() => {
    const map = new Map<string, number>();
    for (const d of distributions) {
      if (d.status !== 'delivered') continue;
      const sector =
        families.find((f) => f.family_id === d.family_id)?.location_sector ?? 'Unknown';
      map.set(sector, (map.get(sector) ?? 0) + 1);
    }
    return Array.from(map, ([sector, count]) => ({ sector, count }));
  }, [families, distributions]);

  // Distributions over time (last 14 days, line chart from /reports) — count deliveries
  const timeData = useMemo(() => {
    const days: { day: string; count: number }[] = [];
    for (let i = 13; i >= 0; i--) {
      const d = new Date(Date.now() - i * 86_400_000);
      const key = d.toISOString().slice(0, 10);
      days.push({
        day: key.slice(5),
        count: distributions.filter(
          (x) =>
            x.status === 'delivered' &&
            (x.delivered_at ?? x.created_at ?? '').slice(0, 10) === key
        ).length,
      });
    }
    return days;
  }, [distributions]);

  const recentDistros = [...distributions]
    .sort((a, b) =>
      (b.delivered_at ?? b.created_at ?? '').localeCompare(a.delivered_at ?? a.created_at ?? '')
    )
    .slice(0, 6);

  const aiStatus =
    conn.state === 'online'
      ? t('connectivity.online')
      : conn.state === 'local'
      ? t('connectivity.local')
      : t('connectivity.disconnected');

  // ---- Actions ------------------------------------------------------------

  const exportCSV = () => {
    const headers = [
      'distribution_id', 'family_id', 'family_name', 'sector', 'status',
      'created_at', 'delivered_at', 'delivered_by',
      'items', 'priority_score', 'flag', 'failure_reason',
    ];
    const rows = distributions.map((d) => {
      const f = families.find((x) => x.family_id === d.family_id);
      return [
        d.distribution_id,
        d.family_id,
        f?.head_name ?? '',
        f?.location_sector ?? '',
        d.status,
        d.created_at,
        d.delivered_at ?? '',
        d.delivered_by ?? d.distributed_by ?? '',
        d.items_distributed.map((i) => `${i.item_name} x${i.quantity}`).join('; '),
        d.ai_priority_score,
        d.new_needs_flagged ? 'yes' : '',
        d.failure_reason ?? '',
      ].map((v) => `"${String(v).replaceAll('"', '""')}"`);
    });
    const csv = [headers.join(','), ...rows.map((r) => r.join(','))].join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `aidflow-export-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  // ---- AI executive summary ----------------------------------------------
  //
  // Builds a rich snapshot of the operation (counts + named sectors + top
  // critical families + recent failures + worker workload) and asks Gemma 4
  // to produce a director-friendly brief. Streams the response so the user
  // sees text appear progressively instead of staring at a blank card for
  // 30+ seconds.
  //
  // If Ollama is unreachable we fall back to a deterministic rule-based
  // summary built from the same snapshot — the button is never silently
  // broken.

  const buildSummaryPayload = () => {
    const familyMap = new Map(families.map((f) => [f.family_id, f]));
    const workerMap = new Map(workers.map((w) => [w.id, w]));

    // Per-sector aggregates
    const sectorStats = new Map<
      string,
      { families: number; critical: number; deliveries: number; pending: number; out_for_delivery: number; failed: number }
    >();
    for (const f of families) {
      const s = f.location_sector;
      const cur = sectorStats.get(s) ?? { families: 0, critical: 0, deliveries: 0, pending: 0, out_for_delivery: 0, failed: 0 };
      cur.families++;
      const score = f.priority_score ?? computeRuleScore(f).priority_score;
      if (score >= 80) cur.critical++;
      sectorStats.set(s, cur);
    }
    for (const d of distributions) {
      const sector = familyMap.get(d.family_id)?.location_sector;
      if (!sector) continue;
      const cur = sectorStats.get(sector);
      if (!cur) continue;
      if (d.status === 'delivered') cur.deliveries++;
      else if (d.status === 'pending') cur.pending++;
      else if (d.status === 'out_for_delivery') cur.out_for_delivery++;
      else if (d.status === 'failed') cur.failed++;
    }

    // Top 5 critical families with reason summary
    const topCritical = [...families]
      .map((f) => {
        const score = f.priority_score ?? computeRuleScore(f).priority_score;
        const reason = f.ai_reason ?? computeRuleScore(f).reason;
        const days = f.last_aid_at
          ? Math.floor((Date.now() - new Date(f.last_aid_at).getTime()) / 86_400_000)
          : null;
        return { family_id: f.family_id, head_name: f.head_name, sector: f.location_sector, score, reason, days_since_last_aid: days, new_need_flagged: !!f.new_need_flagged };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, 5);

    // Recent failed/cancelled deliveries
    const recentIssues = distributions
      .filter((d) => d.status === 'failed' || d.status === 'cancelled')
      .sort((a, b) => (b.closed_at ?? b.created_at).localeCompare(a.closed_at ?? a.created_at))
      .slice(0, 5)
      .map((d) => ({
        order: d.order_number ?? d.distribution_id,
        family: familyMap.get(d.family_id)?.head_name ?? d.family_id,
        sector: familyMap.get(d.family_id)?.location_sector ?? '',
        status: d.status,
        reason: d.failure_reason ?? '',
      }));

    // Stuck orders (out_for_delivery > 24h)
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    const stuckOrders = distributions
      .filter((d) => d.status === 'out_for_delivery' && d.dispatched_at && new Date(d.dispatched_at).getTime() < cutoff)
      .map((d) => ({
        order: d.order_number ?? d.distribution_id,
        family: familyMap.get(d.family_id)?.head_name ?? d.family_id,
        sector: familyMap.get(d.family_id)?.location_sector ?? '',
        worker: d.assigned_to ? workerMap.get(d.assigned_to) ?? null : null,
        dispatched_at: d.dispatched_at,
      }));

    // Worker workload (active orders per worker)
    const workerLoad = workers
      .map((w) => {
        const active = distributions.filter(
          (d) => (d.assigned_to === w.id) && (d.status === 'pending' || d.status === 'out_for_delivery')
        ).length;
        return { name: `${w.first_name} ${w.last_name}`, position: w.position, active };
      })
      .sort((a, b) => b.active - a.active);

    return {
      generated_at: new Date().toISOString(),
      totals: {
        families: families.length,
        critical_priority: criticalCount,
        new_needs_flagged: families.filter((f) => f.new_need_flagged).length,
        deliveries_today: todayDistros.length,
        items_delivered_today: totalItemsToday,
        active_orders: activeOrders,
        pending_orders: distributions.filter((d) => d.status === 'pending').length,
        out_for_delivery_orders: distributions.filter((d) => d.status === 'out_for_delivery').length,
        delivered_lifetime: distributions.filter((d) => d.status === 'delivered').length,
        failed_lifetime: distributions.filter((d) => d.status === 'failed').length,
        stuck_24h: stuckOrders.length,
        sectors_active: sectorStats.size,
        workers_total: workers.length,
      },
      sectors: Array.from(sectorStats.entries())
        .map(([sector, s]) => ({ sector, ...s }))
        .sort((a, b) => b.critical - a.critical),
      top_critical_families: topCritical,
      stuck_orders: stuckOrders,
      recent_failures_or_cancellations: recentIssues,
      worker_workload: workerLoad,
    };
  };

  // Deterministic, no-AI fallback. Always works offline.
  const ruleBasedSummary = (payload: ReturnType<typeof buildSummaryPayload>) => {
    // Pluralize helpers — picks the right form based on count.
    const plural = (n: number, singular: string, plural: string) => `${n} ${n === 1 ? singular : plural}`;
    const t = payload.totals;
    const lines: string[] = [];
    lines.push(`# Operations brief — ${new Date().toLocaleDateString()}`);
    lines.push('');
    lines.push('## Impact');
    lines.push(
      `- ${plural(t.deliveries_today, 'delivery', 'deliveries')} confirmed today (${plural(t.items_delivered_today, 'item', 'items')} total).`
    );
    lines.push(
      `- ${t.delivered_lifetime} lifetime deliveries across ${plural(t.sectors_active, 'sector', 'sectors')}; ${t.failed_lifetime} failed.`
    );
    lines.push(`- ${plural(t.families, 'family', 'families')} tracked, ${plural(t.workers_total, 'worker', 'workers')} on roster.`);
    lines.push('');
    lines.push('## Gaps');
    const gapsBefore = lines.length;
    if (t.critical_priority > 0)
      lines.push(`- ${plural(t.critical_priority, 'family', 'families')} currently at CRITICAL priority — need attention.`);
    if (t.new_needs_flagged > 0)
      lines.push(`- ${plural(t.new_needs_flagged, 'family', 'families')} flagged with a new urgent need on the last visit.`);
    if (t.stuck_24h > 0)
      lines.push(`- ${plural(t.stuck_24h, 'order', 'orders')} stuck in out-for-delivery for over 24h — investigate or reassign.`);
    if (payload.recent_failures_or_cancellations.length > 0) {
      lines.push(
        `- Recent failures/cancellations: ${payload.recent_failures_or_cancellations
          .map((r) => `ORD-${r.order} (${r.family}${r.reason ? ` — ${r.reason}` : ''})`)
          .join('; ')}.`
      );
    }
    if (lines.length === gapsBefore) lines.push('- No major operational gaps detected.');
    lines.push('');
    lines.push('## Top critical families');
    for (const f of payload.top_critical_families) {
      const days = f.days_since_last_aid === null ? 'never' : `${f.days_since_last_aid}d ago`;
      lines.push(`- **${f.head_name}** (${f.family_id}, ${f.sector}) — score ${f.score}, last aid ${days}. ${f.reason}`);
    }
    lines.push('');
    lines.push('## Recommended next actions');
    const recBefore = lines.length;
    if (t.pending_orders > 0) lines.push(`- Dispatch the ${plural(t.pending_orders, 'pending order', 'pending orders')}.`);
    if (t.stuck_24h > 0) lines.push(`- Reach out on the ${plural(t.stuck_24h, 'stuck order', 'stuck orders')} — confirm delivery or mark failed.`);
    if (t.critical_priority > 0)
      lines.push(`- Prioritise the ${plural(t.critical_priority, 'CRITICAL family', 'CRITICAL families')} listed above for the next distribution session.`);
    if (payload.worker_workload[0]?.active >= 2)
      lines.push(`- Workload is concentrated on ${payload.worker_workload[0].name} (${payload.worker_workload[0].active} active) — consider rebalancing.`);
    if (lines.length === recBefore) lines.push('- Operations are steady; continue current cadence.');
    return lines.join('\n');
  };

  const generateSummary = async () => {
    if (generating) return;
    setGenerating(true);
    setSummary('');
    setSummaryError(null);
    setSummarySource(null);

    const payload = buildSummaryPayload();

    // Probe Ollama first so we can fall back gracefully.
    const reachable = await pingOllama();
    if (!reachable) {
      setSummary(ruleBasedSummary(payload));
      setSummarySource('rules');
      setSummaryError('Ollama is not reachable at localhost:11434 — showing a rule-based summary instead. Start Ollama (with `OLLAMA_ORIGINS=*`) and click again for the AI version.');
      setGenerating(false);
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

    // Compact system prompt — short and direct so the model spends its
    // tokens on the brief itself, not on parroting back instructions. We
    // pre-compute a few summary lines so the model doesn't have to re-derive
    // them, and pass the full JSON only as reference for citations.
    const t2 = payload.totals;
    const briefingFacts = [
      `Today: ${t2.deliveries_today} deliveries, ${t2.items_delivered_today} items.`,
      `Active: ${t2.pending_orders} pending + ${t2.out_for_delivery_orders} out-for-delivery (${t2.stuck_24h} stuck >24h).`,
      `Families: ${t2.families} tracked, ${t2.critical_priority} CRITICAL, ${t2.new_needs_flagged} flagged with new urgent need.`,
      `Lifetime: ${t2.delivered_lifetime} delivered, ${t2.failed_lifetime} failed.`,
      `Sectors: ${t2.sectors_active}. Workers: ${t2.workers_total}.`,
    ].join(' ');

    const systemPrompt =
      `You are AidFlow Pro's reporting AI. Respond in ${langName}. ` +
      `Write a director-style executive brief in markdown with EXACTLY these four sections, in this order: ` +
      `## Impact, ## Gaps & risks, ## Top critical cases, ## Recommended actions. ` +
      `Use 2-5 bullet points per section. Cite real family names, family_ids, sectors, and order numbers from the JSON below. ` +
      `Never invent data. Keep total length under ~280 words. Plain markdown only — no tables, no code fences, no preamble. ` +
      `Start your response directly with "## Impact".`;

    const userPrompt =
      `Snapshot summary: ${briefingFacts}\n\n` +
      `Full JSON snapshot for citations:\n` +
      JSON.stringify(payload);

    try {
      let acc = '';
      for await (const delta of chatStream(
        [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        { temperature: 0.4, maxTokens: 1024 }
      )) {
        acc += delta;
        setSummary(acc);
      }
      // Strip any leading whitespace / preamble before the first markdown
      // heading so the rendered document always starts cleanly.
      const cleaned = acc.replace(/^[\s\S]*?(?=## )/, '').trim();
      if (!cleaned) {
        setSummary(ruleBasedSummary(payload));
        setSummarySource('rules');
        setSummaryError('Gemma 4 returned an empty response — showing a rule-based summary instead.');
      } else {
        setSummary(cleaned);
        setSummarySource('ai');
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setSummary(ruleBasedSummary(payload));
      setSummarySource('rules');
      setSummaryError(`Gemma 4 request failed: ${msg}. Showing a rule-based summary instead.`);
    } finally {
      setGenerating(false);
    }
  };

  // ---- Render -------------------------------------------------------------
  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <BarChart3 size={22} />
            {t('nav.dashboard')}
          </h1>
          <p className="text-sm text-slate-400 mt-1">{new Date().toLocaleDateString()}</p>
        </div>
        <button
          onClick={exportCSV}
          className="touch-target px-3 py-2 bg-brand hover:bg-brand-dark rounded-lg text-sm flex items-center gap-2 font-semibold"
        >
          <Download size={14} /> {t('reports.export_csv')}
        </button>
      </header>

      {/* KPI cards */}
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-4">
        <StatCard
          label={t('dashboard.kpi_families')}
          value={todayDistros.length}
          hint={`${families.length} families tracked`}
          accent="brand"
          icon={<Users size={18} />}
        />
        <StatCard
          label="Active orders"
          value={activeOrders}
          hint="pending + out for delivery"
          accent="medium"
          icon={<Package size={18} />}
        />
        <StatCard
          label={t('dashboard.kpi_items')}
          value={totalItemsToday}
          hint={`${distributions.filter((d) => d.status === 'delivered').length} delivered all-time`}
          accent="normal"
          icon={<Package size={18} />}
        />
        <StatCard
          label={t('dashboard.kpi_critical')}
          value={criticalCount}
          hint={`${scored.filter((f) => f.level === 'HIGH').length} high priority`}
          accent="critical"
          icon={<AlertTriangle size={18} />}
        />
        <StatCard
          label={t('dashboard.kpi_ai_status')}
          value={
            <span className="text-base">
              {conn.ollamaUp ? '✓ AidFlow AI' : '— offline'}
            </span>
          }
          hint={aiStatus}
          accent={conn.ollamaUp ? 'ai' : 'medium'}
          icon={<Sparkles size={18} />}
        />
      </div>

      {/* Priority + sector charts */}
      <div className="grid lg:grid-cols-2 gap-6">
        <Card title={t('dashboard.priority_distribution')}>
          <div style={{ width: '100%', height: 240 }}>
            <ResponsiveContainer>
              <PieChart>
                <Pie
                  data={priorityDist}
                  dataKey="value"
                  nameKey="name"
                  innerRadius={50}
                  outerRadius={80}
                  paddingAngle={2}
                >
                  {priorityDist.map((p) => (
                    <Cell key={p.level} fill={PRIORITY_COLORS[p.level]} />
                  ))}
                </Pie>
                <Tooltip
                  contentStyle={{
                    background: '#1e293b',
                    border: '1px solid #475569',
                    borderRadius: 8,
                    color: '#f1f5f9',
                  }}
                />
                <Legend />
              </PieChart>
            </ResponsiveContainer>
          </div>
        </Card>

        <Card title={t('reports.by_sector')}>
          <div style={{ width: '100%', height: 240 }}>
            <ResponsiveContainer>
              <BarChart data={sectorData}>
                <CartesianGrid strokeDasharray="3 3" stroke="rgb(var(--slate-700))" />
                <XAxis
                  dataKey="sector"
                  stroke="rgb(var(--slate-500))"
                  tick={{ fontSize: 11, fill: 'rgb(var(--slate-300))' }}
                />
                <YAxis stroke="rgb(var(--slate-500))" tick={{ fill: 'rgb(var(--slate-300))' }} />
                <Tooltip
                  contentStyle={{
                    background: 'rgb(var(--surface))',
                    border: '1px solid rgb(var(--slate-700))',
                    borderRadius: 8,
                    color: 'rgb(var(--slate-200))',
                  }}
                />
                <Bar dataKey="count" fill="#00ADB5" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </Card>
      </div>

      {/* Distributions over time (from /reports) */}
      <Card title={t('reports.over_time')}>
        <div style={{ height: 220 }}>
          <ResponsiveContainer>
            <LineChart data={timeData}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgb(var(--slate-700))" />
              <XAxis
                dataKey="day"
                stroke="rgb(var(--slate-500))"
                tick={{ fontSize: 11, fill: 'rgb(var(--slate-300))' }}
              />
              <YAxis stroke="rgb(var(--slate-500))" tick={{ fill: 'rgb(var(--slate-300))' }} />
              <Tooltip
                contentStyle={{
                  background: 'rgb(var(--surface))',
                  border: '1px solid rgb(var(--slate-700))',
                  color: 'rgb(var(--slate-200))',
                }}
              />
              <Line
                type="monotone"
                dataKey="count"
                stroke="#8b5cf6"
                strokeWidth={2}
                dot={{ r: 3 }}
              />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </Card>

      {/* Recent distributions (from old /dashboard) */}
      <Card
        title={
          <div className="flex items-center gap-2">
            <TrendingUp size={16} className="text-ai" />
            {t('dashboard.recent_distributions')}
          </div>
        }
        action={
          <Link to="/families" className="text-xs text-brand hover:underline">
            {t('dashboard.view_all')} →
          </Link>
        }
      >
        {recentDistros.length === 0 ? (
          <p className="text-sm text-slate-500 text-center py-4">No distributions yet.</p>
        ) : (
          <ul className="divide-y divide-slate-700">
            {recentDistros.map((d) => {
              const family = families.find((f) => f.family_id === d.family_id);
              return (
                <li key={d.distribution_id} className="py-3 flex items-center gap-3">
                  <Activity size={16} className="text-brand flex-shrink-0" />
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium truncate">
                      {family?.head_name ?? d.family_id}{' '}
                      <span className="text-slate-500">— {d.family_id}</span>
                    </div>
                    <div className="text-xs text-slate-400 truncate">
                      {d.items_distributed
                        .map((i) => `${i.item_name} ×${i.quantity}`)
                        .join(', ')}
                    </div>
                  </div>
                  <PriorityBadge
                    level={levelFromScore(d.ai_priority_score)}
                    score={d.ai_priority_score}
                    size="sm"
                  />
                </li>
              );
            })}
          </ul>
        )}
      </Card>

      {/* AI Executive Summary (from /reports) */}
      <Card
        title={
          <div className="flex items-center gap-2">
            <Sparkles size={14} className="text-ai" /> AI Executive Summary
            {summarySource === 'ai' && (
              <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-ai/15 text-ai font-semibold">
                Gemma 4
              </span>
            )}
            {summarySource === 'rules' && (
              <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-priority-medium/15 text-priority-medium font-semibold flex items-center gap-1">
                <WifiOff size={10} /> Rule-based fallback
              </span>
            )}
          </div>
        }
        action={
          <button
            onClick={() => void generateSummary()}
            disabled={generating}
            className="touch-target px-3 py-1.5 bg-ai hover:bg-violet-600 disabled:opacity-50 rounded-lg text-xs flex items-center gap-1 font-semibold"
          >
            {generating ? (
              <Loading />
            ) : summary ? (
              <RefreshCw size={12} />
            ) : (
              <Sparkles size={12} />
            )}
            {generating
              ? 'Generating…'
              : summary
              ? 'Regenerate'
              : t('reports.summary')}
          </button>
        }
      >
        {summaryError && (
          <div className="mb-3 text-xs px-3 py-2 rounded-lg bg-priority-medium/10 border border-priority-medium/30 text-priority-medium flex items-start gap-2">
            <AlertTriangle size={14} className="flex-shrink-0 mt-0.5" />
            <span>{summaryError}</span>
          </div>
        )}
        {summary ? (
          <div className="prose-ai text-sm text-slate-200 leading-relaxed break-words">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{summary}</ReactMarkdown>
          </div>
        ) : generating ? (
          <p className="text-sm text-slate-500 italic">Asking Gemma 4 to draft the executive brief…</p>
        ) : (
          <p className="text-sm text-slate-500">{t('reports.summary_placeholder')}</p>
        )}
      </Card>
    </div>
  );
}
