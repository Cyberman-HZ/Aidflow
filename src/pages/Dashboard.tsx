// Dashboard & Reports — merged page.
// Combines the live KPIs/recent-distributions view with the historical charts,
// CSV export, and AI executive summary that used to live on /reports.

import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import {
  Users,
  Package,
  AlertTriangle,
  Sparkles,
  TrendingUp,
  Activity,
  Download,
  BarChart3,
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
import { chat } from '@/services/ollama';
import type { Family, AidDistribution } from '@/types';

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

  const [families, setFamilies] = useState<Family[]>([]);
  const [distributions, setDistributions] = useState<AidDistribution[]>([]);
  const [summary, setSummary] = useState('');
  const [generating, setGenerating] = useState(false);

  useEffect(() => {
    void Promise.all([db.families.toArray(), db.distributions.toArray()]).then(
      ([fams, dists]) => {
        setFamilies(fams);
        setDistributions(dists);
      }
    );
  }, []);

  // ---- Derived data --------------------------------------------------------
  const today = new Date().toISOString().slice(0, 10);
  const todayDistros = distributions.filter((d) => d.distributed_at.slice(0, 10) === today);
  const totalItemsToday = todayDistros.reduce(
    (sum, d) => sum + d.items_distributed.reduce((s, it) => s + it.quantity, 0),
    0
  );

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

  // Distributions per sector (bar)
  const sectorData = useMemo(() => {
    const map = new Map<string, number>();
    for (const d of distributions) {
      const sector =
        families.find((f) => f.family_id === d.family_id)?.location_sector ?? 'Unknown';
      map.set(sector, (map.get(sector) ?? 0) + 1);
    }
    return Array.from(map, ([sector, count]) => ({ sector, count }));
  }, [families, distributions]);

  // Distributions over time (last 14 days, line chart from /reports)
  const timeData = useMemo(() => {
    const days: { day: string; count: number }[] = [];
    for (let i = 13; i >= 0; i--) {
      const d = new Date(Date.now() - i * 86_400_000);
      const key = d.toISOString().slice(0, 10);
      days.push({
        day: key.slice(5),
        count: distributions.filter((x) => x.distributed_at.slice(0, 10) === key).length,
      });
    }
    return days;
  }, [distributions]);

  const recentDistros = [...distributions]
    .sort((a, b) => b.distributed_at.localeCompare(a.distributed_at))
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
      'distribution_id',
      'family_id',
      'family_name',
      'sector',
      'distributed_at',
      'distributed_by',
      'items',
      'priority_score',
      'flag',
    ];
    const rows = distributions.map((d) => {
      const f = families.find((x) => x.family_id === d.family_id);
      return [
        d.distribution_id,
        d.family_id,
        f?.head_name ?? '',
        f?.location_sector ?? '',
        d.distributed_at,
        d.distributed_by,
        d.items_distributed.map((i) => `${i.item_name} x${i.quantity}`).join('; '),
        d.ai_priority_score,
        d.new_needs_flagged ? 'yes' : '',
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

  const generateSummary = async () => {
    if (generating) return;
    setGenerating(true);
    setSummary('');
    try {
      const langName =
        language === 'ar'
          ? 'Arabic'
          : language === 'fr'
          ? 'French'
          : language === 'es'
          ? 'Spanish'
          : 'English';
      const stats = {
        families: families.length,
        distributions_total: distributions.length,
        distributions_today: todayDistros.length,
        critical_priority: criticalCount,
        sectors_active: new Set(
          distributions.map((d) => families.find((f) => f.family_id === d.family_id)?.location_sector)
        ).size,
        new_needs_flagged: families.filter((f) => f.new_need_flagged).length,
      };
      const text = await chat(
        [
          {
            role: 'system',
            content: `You are AidFlow Pro's reporting AI. Produce a concise executive summary (3 short paragraphs) highlighting impact, gaps, and recommended next actions for a humanitarian operations director. Use clear markdown headings and bullets where helpful. Respond in ${langName}.`,
          },
          { role: 'user', content: JSON.stringify(stats) },
        ],
        { temperature: 0.4, maxTokens: 600 }
      );
      setSummary(text);
    } catch {
      setSummary('Could not reach AidFlow Assistant. Verify Ollama is running.');
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
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard
          label={t('dashboard.kpi_families')}
          value={todayDistros.length}
          hint={`${families.length} total tracked`}
          accent="brand"
          icon={<Users size={18} />}
        />
        <StatCard
          label={t('dashboard.kpi_items')}
          value={totalItemsToday}
          hint={`${distributions.length} all-time`}
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
                <CartesianGrid strokeDasharray="3 3" stroke="#334155" />
                <XAxis dataKey="sector" stroke="#94a3b8" tick={{ fontSize: 11 }} />
                <YAxis stroke="#94a3b8" />
                <Tooltip
                  contentStyle={{
                    background: '#1e293b',
                    border: '1px solid #475569',
                    borderRadius: 8,
                  }}
                />
                <Bar dataKey="count" fill="#0ea5e9" radius={[4, 4, 0, 0]} />
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
              <CartesianGrid strokeDasharray="3 3" stroke="#334155" />
              <XAxis dataKey="day" stroke="#94a3b8" tick={{ fontSize: 11 }} />
              <YAxis stroke="#94a3b8" />
              <Tooltip contentStyle={{ background: '#1e293b', border: '1px solid #475569' }} />
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
          </div>
        }
        action={
          <button
            onClick={() => void generateSummary()}
            disabled={generating}
            className="touch-target px-3 py-1.5 bg-ai hover:bg-violet-600 disabled:opacity-50 rounded-lg text-xs flex items-center gap-1 font-semibold"
          >
            {generating ? <Loading /> : <Sparkles size={12} />}
            {t('reports.summary')}
          </button>
        }
      >
        {summary ? (
          <p className="text-sm text-slate-200 whitespace-pre-wrap">{summary}</p>
        ) : (
          <p className="text-sm text-slate-500">{t('reports.summary_placeholder')}</p>
        )}
      </Card>
    </div>
  );
}
