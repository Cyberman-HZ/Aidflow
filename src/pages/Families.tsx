import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import {
  Search,
  Sparkles,
  RefreshCw,
  Users,
  Baby,
  HeartPulse,
  Activity,
  ArrowUpDown,
  X,
  Package,
  Edit2,
  UserPlus,
} from 'lucide-react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '@/db/database';
import { prioritizeFamilies } from '@/services/ollama';
import { computeRuleScore, sortByScore } from '@/services/priorityRules';
import { useSettingsStore } from '@/stores/settingsStore';
import PriorityBadge from '@/components/PriorityBadge';
import { Card } from '@/components/Card';
import EmptyState from '@/components/EmptyState';
import Loading from '@/components/Loading';
import FamilyEditModal from '@/components/FamilyEditModal';
import type { AidDistribution, Family, PrioritizationResult, PriorityLevel } from '@/types';

type PriorityFilter = 'ALL' | PriorityLevel;
type SortKey =
  | 'score_desc'
  | 'score_asc'
  | 'name'
  | 'id'
  | 'members'
  | 'children'
  | 'last_aid_asc'
  | 'last_aid_desc'
  | 'sector';

export default function Families() {
  const { t } = useTranslation();
  const language = useSettingsStore((s) => s.language);
  const [search, setSearch] = useState('');
  const [sectorFilter, setSectorFilter] = useState<string>('');
  const [priorityFilter, setPriorityFilter] = useState<PriorityFilter>('ALL');
  const [sortKey, setSortKey] = useState<SortKey>('score_desc');
  const [running, setRunning] = useState(false);
  const [results, setResults] = useState<PrioritizationResult[]>([]);
  // Modal state — null means closed; { mode: 'create' } or { mode: 'edit', family }
  const [modal, setModal] = useState<
    { mode: 'create' } | { mode: 'edit'; family: Family } | null
  >(null);

  const families = useLiveQuery(() => db.families.toArray(), []) ?? [];
  // Pulled live so the priority score reflects delivery history (recent
  // successful deliveries lower the score, failed/cancelled raise it).
  const distributions = useLiveQuery(() => db.distributions.toArray(), []) ?? [];

  // Compute initial scores with the rule engine so the page is useful
  // even before the user clicks "Re-run AI prioritization".
  const ruleResults = useMemo(() => {
    // Group distributions by family_id once for O(1) per-family lookup.
    const byFamily = new Map<string, AidDistribution[]>();
    for (const d of distributions) {
      const arr = byFamily.get(d.family_id);
      if (arr) arr.push(d);
      else byFamily.set(d.family_id, [d]);
    }
    return sortByScore(
      families.map((f) => computeRuleScore(f, byFamily.get(f.family_id) ?? []))
    );
  }, [families, distributions]);

  const effectiveResults = results.length ? results : ruleResults;
  const byId = new Map(effectiveResults.map((r) => [r.family_id, r]));

  const sectors = useMemo(
    () => Array.from(new Set(families.map((f) => f.location_sector))).sort(),
    [families]
  );

  // Trim once so a stray space at the start/end of the search box doesn't
  // wipe the result list — common when users paste or tap-type on mobile.
  const q = search.trim().toLowerCase();
  const filtered = families
    .filter((f) => !sectorFilter || f.location_sector === sectorFilter)
    .filter((f) => {
      if (priorityFilter === 'ALL') return true;
      return byId.get(f.family_id)?.priority_level === priorityFilter;
    })
    .filter(
      (f) =>
        !q ||
        f.head_name.toLowerCase().includes(q) ||
        f.family_id.toLowerCase().includes(q)
    );

  // Sort with the selected key. Ties fall back to priority score.
  const daysSince = (iso: string | undefined) =>
    iso ? Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000) : Number.POSITIVE_INFINITY;

  filtered.sort((a, b) => {
    const sa = byId.get(a.family_id)?.priority_score ?? 0;
    const sb = byId.get(b.family_id)?.priority_score ?? 0;
    switch (sortKey) {
      case 'score_desc':
        return sb - sa;
      case 'score_asc':
        return sa - sb;
      case 'name':
        return a.head_name.localeCompare(b.head_name);
      case 'id':
        return a.family_id.localeCompare(b.family_id);
      case 'members':
        return b.member_count - a.member_count || sb - sa;
      case 'children':
        return b.children_under_5 - a.children_under_5 || sb - sa;
      case 'last_aid_asc':
        return daysSince(b.last_aid_at) - daysSince(a.last_aid_at);
      case 'last_aid_desc':
        return daysSince(a.last_aid_at) - daysSince(b.last_aid_at);
      case 'sector':
        return a.location_sector.localeCompare(b.location_sector) || sb - sa;
      default:
        return 0;
    }
  });

  const hasActiveFilter =
    !!search || !!sectorFilter || priorityFilter !== 'ALL' || sortKey !== 'score_desc';

  const clearFilters = () => {
    setSearch('');
    setSectorFilter('');
    setPriorityFilter('ALL');
    setSortKey('score_desc');
  };

  const runAI = async () => {
    if (running || families.length === 0) return;
    setRunning(true);
    try {
      const out = await prioritizeFamilies(filtered, language);
      setResults(out);
      // Persist ONLY the priority_score back to Dexie. Re-running AI
      // prioritization is a re-scoring action — it must not touch the
      // priority_level / reasoning / recommended_items / medical_conditions
      // / any other field. Those are owned by the user (via family edit,
      // delivery confirmation, or the AI assistant action protocol) and
      // re-scoring should be free of side effects.
      await db.transaction('rw', db.families, async () => {
        for (const r of out) {
          const f = await db.families.get(r.family_id);
          if (f) {
            await db.families.put({
              ...f,
              priority_score: r.priority_score,
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
        <div className="flex items-center gap-2 flex-wrap">
          <button
            onClick={() => setModal({ mode: 'create' })}
            className="touch-target px-4 py-2 bg-brand hover:bg-brand-dark rounded-lg flex items-center gap-2 text-sm font-semibold transition-colors text-white"
          >
            <UserPlus size={16} />
            <span>{t('families_edit.add_family')}</span>
          </button>
          <button
            onClick={() => void runAI()}
            disabled={running}
            className="touch-target px-4 py-2 bg-ai hover:bg-violet-600 disabled:opacity-60 rounded-lg flex items-center gap-2 text-sm font-semibold transition-colors"
          >
            {running ? <RefreshCw size={16} className="animate-spin" /> : <Sparkles size={16} />}
            <span>{t('families.rerun_ai')}</span>
          </button>
        </div>
      </header>

      <Card>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
          {/* Search — spans 2 cols on lg */}
          <div className="relative lg:col-span-2">
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

          {/* Sector */}
          <select
            value={sectorFilter}
            onChange={(e) => setSectorFilter(e.target.value)}
            className="bg-surface-deep border border-slate-700 rounded-lg px-3 py-2 text-sm focus:border-brand touch-target"
            aria-label={t('families.filter_sector')}
          >
            <option value="">{t('families.filter_sector')}</option>
            {sectors.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>

          {/* Priority level */}
          <select
            value={priorityFilter}
            onChange={(e) => setPriorityFilter(e.target.value as PriorityFilter)}
            className="bg-surface-deep border border-slate-700 rounded-lg px-3 py-2 text-sm focus:border-brand touch-target"
            aria-label={t('families.filter_priority')}
          >
            <option value="ALL">{t('families.filter_priority')}</option>
            <option value="CRITICAL">{t('priority.CRITICAL')}</option>
            <option value="HIGH">{t('priority.HIGH')}</option>
            <option value="MEDIUM">{t('priority.MEDIUM')}</option>
            <option value="NORMAL">{t('priority.NORMAL')}</option>
          </select>
        </div>

        <div className="mt-3 pt-3 border-t border-slate-700 flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-2 text-sm text-slate-300">
            <ArrowUpDown size={14} className="text-slate-400" />
            <span className="text-xs text-slate-400">{t('families.sort_by')}:</span>
            <select
              value={sortKey}
              onChange={(e) => setSortKey(e.target.value as SortKey)}
              className="bg-surface-deep border border-slate-700 rounded-lg px-2 py-1.5 text-sm focus:border-brand"
            >
              <option value="score_desc">{t('families.sort_score_desc')}</option>
              <option value="score_asc">{t('families.sort_score_asc')}</option>
              <option value="name">{t('families.sort_name')}</option>
              <option value="id">{t('families.sort_id')}</option>
              <option value="members">{t('families.sort_members')}</option>
              <option value="children">{t('families.sort_children')}</option>
              <option value="last_aid_asc">{t('families.sort_last_aid_asc')}</option>
              <option value="last_aid_desc">{t('families.sort_last_aid_desc')}</option>
              <option value="sector">{t('families.sort_sector')}</option>
            </select>
          </label>

          {hasActiveFilter && (
            <button
              onClick={clearFilters}
              className="ms-auto touch-target px-3 py-1.5 bg-surface-light hover:bg-slate-600 rounded-lg text-xs flex items-center gap-1"
            >
              <X size={12} /> {t('distribute.filter_clear')}
            </button>
          )}
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
            return (
              <FamilyRow
                key={f.family_id}
                family={f}
                result={r}
                onEdit={() => setModal({ mode: 'edit', family: f })}
              />
            );
          })}
        </div>
      )}

      {modal && (
        <FamilyEditModal
          existing={modal.mode === 'edit' ? modal.family : undefined}
          onClose={() => setModal(null)}
        />
      )}
    </div>
  );
}

function FamilyRow({
  family,
  result,
  onEdit,
}: {
  family: Family;
  result?: PrioritizationResult;
  onEdit: () => void;
}) {
  const { t } = useTranslation();
  const score = result?.priority_score ?? 0;
  const level = result?.priority_level ?? 'NORMAL';
  const days = family.last_aid_at
    ? Math.floor((Date.now() - new Date(family.last_aid_at).getTime()) / 86_400_000)
    : null;

  // Prefer AI-cached recommended items if present; otherwise rule-engine output.
  const items =
    // Treat the family record as the source of truth: an explicit empty
    // array means "no current needs" (e.g. just cleared via mark-delivered)
    // and must NOT be overwritten by the rule engine's default suggestions.
    // Only fall back to the rule engine when the field was never set.
    family.recommended_items !== undefined
      ? family.recommended_items
      : result?.recommended_items ?? [];

  return (
    <div className="group relative bg-surface hover:bg-surface-light border border-slate-700 hover:border-brand/40 rounded-xl transition-colors">
      <Link
        to={`/families/${family.family_id}`}
        className="block px-4 py-3 focus:outline-none"
      >
        <div className="min-w-0 pe-10">
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
                {t('families.medical_count', {
                  count: family.medical_conditions.length,
                })}
              </span>
            )}
            <span>· {family.location_sector}</span>
            <span className="flex items-center gap-1">
              <Activity size={12} />
              {days === null ? t('families.never') : t('families.days_ago', { n: days })}
            </span>
          </div>
          {items.length > 0 && (
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              <span className="text-[10px] font-semibold text-slate-500 uppercase tracking-wide flex items-center gap-1">
                <Package size={11} /> {t('families.needs')}:
              </span>
              {items.slice(0, 6).map((item, i) => (
                <span
                  key={i}
                  className="text-[11px] bg-ai/15 text-ai border border-ai/30 px-2 py-0.5 rounded-full"
                >
                  {item.name} <span className="opacity-70">×{item.quantity}</span>
                </span>
              ))}
              {items.length > 6 && (
                <span className="text-[11px] text-slate-500">+{items.length - 6} more</span>
              )}
              </div>
          )}
        </div>
      </Link>

      {/* Edit pencil — top-right ghost button, always visible. */}
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          e.preventDefault();
          onEdit();
        }}
        aria-label={t('families_edit.edit_family', { name: family.head_name })}
        title={t('families_edit.edit_title')}
        className="absolute top-3 end-3 z-10 p-1.5 rounded-md text-slate-400 hover:text-brand hover:bg-brand/10 transition-colors"
      >
        <Edit2 size={16} />
      </button>
    </div>
  );
}
