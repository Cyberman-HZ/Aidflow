import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { BarChart3, Download, Sparkles } from 'lucide-react';
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  LineChart,
  Line,
  PieChart,
  Pie,
  Cell,
  Legend,
} from 'recharts';
import { db } from '@/db/database';
import { Card } from '@/components/Card';
import Loading from '@/components/Loading';
import { chat } from '@/services/ollama';
import { useSettingsStore } from '@/stores/settingsStore';
import type { Family, AidDistribution } from '@/types';

export default function Reports() {
  const { t } = useTranslation();
  const language = useSettingsStore((s) => s.language);
  const [families, setFamilies] = useState<Family[]>([]);
  const [distros, setDistros] = useState<AidDistribution[]>([]);
  const [summary, setSummary] = useState('');
  const [generating, setGenerating] = useState(false);

  useEffect(() => {
    void Promise.all([db.families.toArray(), db.distributions.toArray()]).then(
      ([f, d]) => {
        setFamilies(f);
        setDistros(d);
      }
    );
  }, []);

  // Distributions per sector
  const sectorData = useMemo(() => {
    const map = new Map<string, number>();
    for (const d of distros) {
      const sector = families.find((f) => f.family_id === d.family_id)?.location_sector ?? 'Unknown';
      map.set(sector, (map.get(sector) ?? 0) + 1);
    }
    return Array.from(map, ([sector, count]) => ({ sector, count }));
  }, [families, distros]);

  // Distributions over time (last 14 days)
  const timeData = useMemo(() => {
    const days: { day: string; count: number }[] = [];
    for (let i = 13; i >= 0; i--) {
      const d = new Date(Date.now() - i * 86_400_000);
      const key = d.toISOString().slice(0, 10);
      days.push({
        day: key.slice(5),
        count: distros.filter((x) => x.distributed_at.slice(0, 10) === key).length,
      });
    }
    return days;
  }, [distros]);

  const priorityData = useMemo(() => {
    const buckets = { CRITICAL: 0, HIGH: 0, MEDIUM: 0, NORMAL: 0 };
    for (const f of families) {
      const lvl = f.priority_level ?? 'NORMAL';
      buckets[lvl] += 1;
    }
    return [
      { name: t('priority.CRITICAL'), value: buckets.CRITICAL, color: '#ef4444' },
      { name: t('priority.HIGH'), value: buckets.HIGH, color: '#f97316' },
      { name: t('priority.MEDIUM'), value: buckets.MEDIUM, color: '#eab308' },
      { name: t('priority.NORMAL'), value: buckets.NORMAL, color: '#22c55e' },
    ];
  }, [families, t]);

  const exportCSV = () => {
    const headers = [
      'distribution_id', 'family_id', 'family_name', 'sector',
      'distributed_at', 'distributed_by', 'items', 'priority_score', 'flag',
    ];
    const rows = distros.map((d) => {
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
        language === 'ar' ? 'Arabic' : language === 'fr' ? 'French' : language === 'es' ? 'Spanish' : 'English';
      const stats = {
        families: families.length,
        distributions_total: distros.length,
        distributions_today: distros.filter(
          (d) => d.distributed_at.slice(0, 10) === new Date().toISOString().slice(0, 10)
        ).length,
        critical_priority: families.filter((f) => (f.priority_score ?? 0) >= 80).length,
        sectors_active: new Set(
          distros.map((d) => families.find((f) => f.family_id === d.family_id)?.location_sector)
        ).size,
      };
      const text = await chat(
        [
          {
            role: 'system',
            content: `You are AidFlow Pro's reporting AI. Produce a concise executive summary (3 short paragraphs) highlighting impact, gaps, and recommended next actions for a humanitarian operations director. Respond in ${langName}.`,
          },
          { role: 'user', content: JSON.stringify(stats) },
        ],
        { temperature: 0.4, maxTokens: 600 }
      );
      setSummary(text);
    } catch (e) {
      setSummary('Could not reach Gemma 4. Verify Ollama is running.');
    } finally {
      setGenerating(false);
    }
  };

  return (
    <div className="space-y-5">
      <header className="flex items-center justify-between">
        <h1 className="text-2xl font-bold flex items-center gap-2">
          <BarChart3 size={22} />
          {t('reports.title')}
        </h1>
        <button
          onClick={exportCSV}
          className="touch-target px-3 py-2 bg-brand hover:bg-brand-dark rounded-lg text-sm flex items-center gap-2 font-semibold"
        >
          <Download size={14} /> {t('reports.export_csv')}
        </button>
      </header>

      <div className="grid lg:grid-cols-2 gap-5">
        <Card title={t('reports.by_sector')}>
          <div style={{ height: 240 }}>
            <ResponsiveContainer>
              <BarChart data={sectorData}>
                <CartesianGrid strokeDasharray="3 3" stroke="#334155" />
                <XAxis dataKey="sector" stroke="#94a3b8" tick={{ fontSize: 11 }} />
                <YAxis stroke="#94a3b8" />
                <Tooltip contentStyle={{ background: '#1e293b', border: '1px solid #475569' }} />
                <Bar dataKey="count" fill="#0ea5e9" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </Card>

        <Card title={t('reports.by_priority')}>
          <div style={{ height: 240 }}>
            <ResponsiveContainer>
              <PieChart>
                <Pie data={priorityData} dataKey="value" nameKey="name" outerRadius={80}>
                  {priorityData.map((p, i) => <Cell key={i} fill={p.color} />)}
                </Pie>
                <Tooltip contentStyle={{ background: '#1e293b', border: '1px solid #475569' }} />
                <Legend />
              </PieChart>
            </ResponsiveContainer>
          </div>
        </Card>
      </div>

      <Card title={t('reports.over_time')}>
        <div style={{ height: 220 }}>
          <ResponsiveContainer>
            <LineChart data={timeData}>
              <CartesianGrid strokeDasharray="3 3" stroke="#334155" />
              <XAxis dataKey="day" stroke="#94a3b8" tick={{ fontSize: 11 }} />
              <YAxis stroke="#94a3b8" />
              <Tooltip contentStyle={{ background: '#1e293b', border: '1px solid #475569' }} />
              <Line type="monotone" dataKey="count" stroke="#8b5cf6" strokeWidth={2} dot={{ r: 3 }} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </Card>

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
