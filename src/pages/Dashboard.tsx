import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import {
  Users,
  Package,
  AlertTriangle,
  Sparkles,
  TrendingUp,
  Activity,
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
} from 'recharts';
import { Card, StatCard } from '@/components/Card';
import PriorityBadge, { levelFromScore } from '@/components/PriorityBadge';
import { db } from '@/db/database';
import { useConnectivityStore } from '@/stores/connectivityStore';
import { computeRuleScore } from '@/services/priorityRules';
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
  const [families, setFamilies] = useState<Family[]>([]);
  const [distributions, setDistributions] = useState<AidDistribution[]>([]);

  useEffect(() => {
    void Promise.all([db.families.toArray(), db.distributions.toArray()]).then(
      ([fams, dists]) => {
        setFamilies(fams);
        setDistributions(dists);
      }
    );
  }, []);

  const today = new Date().toISOString().slice(0, 10);
  const todayDistros = distributions.filter((d) => d.distributed_at.slice(0, 10) === today);
  const totalItemsToday = todayDistros.reduce(
    (sum, d) => sum + d.items_distributed.reduce((s, it) => s + it.quantity, 0),
    0
  );

  const scored = families.map((f) => ({
    ...f,
    score: f.priority_score ?? computeRuleScore(f).priority_score,
    level: f.priority_level ?? computeRuleScore(f).priority_level,
  }));
  const criticalCount = scored.filter((f) => f.score >= 80).length;

  // Priority distribution for the pie chart
  const priorityDist = (['CRITICAL', 'HIGH', 'MEDIUM', 'NORMAL'] as const).map((lvl) => ({
    name: t(`priority.${lvl}`),
    level: lvl,
    value: scored.filter((f) => f.level === lvl).length,
  }));

  // Distribution per sector (bar)
  const sectorMap = new Map<string, number>();
  for (const d of distributions) {
    const sector = families.find((f) => f.family_id === d.family_id)?.location_sector ?? 'Unknown';
    sectorMap.set(sector, (sectorMap.get(sector) ?? 0) + 1);
  }
  const sectorData = Array.from(sectorMap, ([sector, count]) => ({ sector, count }));

  const recentDistros = [...distributions]
    .sort((a, b) => b.distributed_at.localeCompare(a.distributed_at))
    .slice(0, 6);

  const aiStatus =
    conn.state === 'online'
      ? t('connectivity.online')
      : conn.state === 'local'
      ? t('connectivity.local')
      : t('connectivity.disconnected');

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-bold">{t('dashboard.title')}</h1>
        <p className="text-sm text-slate-400 mt-1">{new Date().toLocaleDateString()}</p>
      </header>

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
            <span className="text-base">{conn.ollamaUp ? '✓ Gemma 4' : '— offline'}</span>
          }
          hint={aiStatus}
          accent={conn.ollamaUp ? 'ai' : 'medium'}
          icon={<Sparkles size={18} />}
        />
      </div>

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

        <Card title={t('dashboard.recent_distributions')}>
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
    </div>
  );
}
