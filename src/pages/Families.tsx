import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { Search, Sparkles, RefreshCw, Users, Baby, HeartPulse, Activity } from 'lucide-react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '@/db/database';
import { prioritizeFamilies } from '@/services/ollama';
import { computeRuleScore, sortByScore } from '@/services/priorityRules';
import { useSettingsStore } from '@/stores/settingsStore';
import PriorityBadge from '@/components/PriorityBadge';
import { Card } from '@/components/Card';
import EmptyState from '@/components/EmptyState';
import Loading from '@/components/Loading';
import type { Family, PrioritizationResult } from '@/types';

export default function Families() {
  const { t } = useTranslation();
  const language = useSettingsStore((s) => s.language);
  const [search, setSearch] = useState('');
  const [sectorFilter, setSectorFilter] = useState<string>('');
  const [running, setRunning] = useState(false);
  const [results, setResults] = useState<PrioritizationResult[]>([]);

  const families = useLiveQuery(() => db.families.toArray(), []) ?? [];

  // Compute initial scores with the rule engine so the page is useful
  // even before the user clicks "Re-run AI prioritization".
  const ruleResults = useMemo(
    () => sortByScore(families.map(computeRuleScore)),
    [families]
  );

  const effectiveResults = results.length ? results : ruleResults;
  const byId = new Map(effectiveResults.map((r) => [r.family_id, r]));

  const sectors = useMemo(
    () => Array.from(new Set(families.map((f) => f.location_sector))).sort(),
    [families]
  );

  const filtered = families
    .filter((f) => !sectorFilter || f.location_sector === sectorFilter)
    .filter(
      (f) =>
        !search ||
        f.head_name.toLowerCase().includes(search.toLowerCase()) ||
        f.family_id.toLowerCase().includes(search.toLowerCase())
    );

  // sort by AI/rule score
  filtered.sort((a, b) => {
    const sa = byId.get(a.family_id)?.priority_score ?? 0;
    const sb = byId.get(b.family_id)?.priority_score ?? 0;
    return sb - sa;
  });

  const runAI = async () => {
    if (running || families.length === 0) return;
    setRunning(true);
    try {
      const out = await prioritizeFamilies(filtered, language);
      setResults(out);
      // Persist scores back to Dexie so they're cached for the session
      await db.transaction('rw', db.families, async () => {
        for (const r of out) {
          const f = await db.families.get(r.family_id);
          if (f) {
            await db.families.put({
              ...f,
              priority_score: r.priority_score,
              priority_level: r.priority_level,
              ai_reason: r.reason,
              recommended_items: r.recommended_items,
            });
          }
        }
      });
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="space-y-4">
      <header className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold">{t('families.title')}</h1>
          <p className="text-sm text-slate-400">
            {filtered.length} / {families.length}
          </p>
        </div>
        <button
          onClick={() => void runAI()}
          disabled={running}
          className="touch-target px-4 py-2 bg-ai hover:bg-violet-600 disabled:opacity-60 rounded-lg flex items-center gap-2 text-sm font-semibold transition-colors"
        >
          {running ? <RefreshCw size={16} className="animate-spin" /> : <Sparkles size={16} />}
          <span>{t('families.rerun_ai')}</span>
        </button>
      </header>

      <Card>
        <div className="flex flex-col sm:flex-row gap-3 items-stretch">
          <div className="relative flex-1">
            <Search
              size={16}
              className="absolute top-1/2 -translate-y-1/2 start-3 text-slate-500"
            />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t('families.search')}
              className="w-full bg-surface-deep border border-slate-700 rounded-lg ps-9 pe-3 py-2 text-sm focus:border-brand outline-none touch-target"
            />
          </div>
          <select
            value={sectorFilter}
            onChange={(e) => setSectorFilter(e.target.value)}
            className="bg-surface-deep border border-slate-700 rounded-lg px-3 py-2 text-sm focus:border-brand touch-target"
          >
            <option value="">{t('families.filter_sector')}</option>
            {sectors.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </div>
      </Card>

      {running && (
        <Card>
          <Loading label={t('families.loading_ai', { count: filtered.length })} />
        </Card>
      )}

      {filtered.length === 0 ? (
        <Card>
          <EmptyState icon={<Users size={28} />} title={t('families.no_families')} />
        </Card>
      ) : (
        <div className="space-y-2">
          {filtered.map((f) => {
            const r = byId.get(f.family_id);
            return <FamilyRow key={f.family_id} family={f} result={r} />;
          })}
        </div>
      )}
    </div>
  );
}

function FamilyRow({ family, result }: { family: Family; result?: PrioritizationResult }) {
  const { t } = useTranslation();
  const score = result?.priority_score ?? 0;
  const level = result?.priority_level ?? 'NORMAL';
  const days = family.last_aid_at
    ? Math.floor((Date.now() - new Date(family.last_aid_at).getTime()) / 86_400_000)
    : null;

  return (
    <Link
      to={`/families/${family.family_id}`}
      className="block bg-surface hover:bg-surface-light border border-slate-700 hover:border-brand/40 rounded-xl px-4 py-3 transition-colors"
    >
      <div className="flex items-start gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-semibold truncate">{family.head_name}</span>
            <span className="text-xs text-slate-500">{family.family_id}</span>
            <PriorityBadge level={level} score={score} size="sm" />
          </div>
          <div className="text-xs text-slate-400 mt-1 flex flex-wrap gap-x-3 gap-y-1">
            <span className="flex items-center gap-1">
              <Users size={12} />
              {family.member_count} {t('families.members')}
            </span>
            {family.children_under_5 > 0 && (
              <span className="flex items-center gap-1">
                <Baby size={12} />
                {family.children_under_5} {t('families.children_under5')}
              </span>
            )}
            {family.medical_conditions.length > 0 && (
              <span className="flex items-center gap-1 text-priority-high">
                <HeartPulse size={12} />
                {family.medical_conditions.length} medical
              </span>
            )}
            <span>· {family.location_sector}</span>
            <span className="flex items-center gap-1">
              <Activity size={12} />
              {days === null ? t('families.never') : t('families.days_ago', { n: days })}
            </span>
          </div>
          {result?.reason && (
            <p className="text-xs text-ai mt-1.5 italic line-clamp-2">{result.reason}</p>
          )}
        </div>
        <div className="text-2xl font-bold tabular-nums" style={{ color: colorForLevel(level) }}>
          {score}
        </div>
      </div>
    </Link>
  );
}

function colorForLevel(level: string) {
  switch (level) {
    case 'CRITICAL': return '#ef4444';
    case 'HIGH': return '#f97316';
    case 'MEDIUM': return '#eab308';
    default: return '#22c55e';
  }
}
