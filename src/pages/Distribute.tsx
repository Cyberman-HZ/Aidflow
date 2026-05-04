import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate, Link } from 'react-router-dom';
import {
  PackageCheck,
  ChevronRight,
  ChevronLeft,
  AlertTriangle,
  Plus,
  X,
  CheckCircle2,
  History as HistoryIcon,
  Search,
  Download,
  Flag,
  Calendar,
} from 'lucide-react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '@/db/database';
import { Card } from '@/components/Card';
import PriorityBadge from '@/components/PriorityBadge';
import EmptyState from '@/components/EmptyState';
import Loading from '@/components/Loading';
import { computeRuleScore, sortByScore } from '@/services/priorityRules';
import { recomputeAfterUpdate } from '@/services/ollama';
import { useAuthStore } from '@/stores/authStore';
import { useSettingsStore } from '@/stores/settingsStore';
import type { Family, AidDistribution, PrioritizationResult, User } from '@/types';

const ITEM_TEMPLATES = [
  { name: 'Family food parcel (15 days)', category: 'food' },
  { name: 'Drinking water (20L)', category: 'water' },
  { name: 'Hygiene kit', category: 'general' },
  { name: 'Infant formula', category: 'food' },
  { name: 'High-protein rations', category: 'food' },
  { name: 'Prenatal supplements', category: 'medical' },
  { name: 'Medical kit', category: 'medical' },
  { name: 'Mosquito net', category: 'protection' },
  { name: 'Shelter tarp (4×6m)', category: 'shelter' },
  { name: 'Blankets', category: 'shelter' },
  { name: 'Water purification tablets', category: 'water' },
  { name: 'Oral rehydration salts', category: 'medical' },
];

interface LineItem {
  item_name: string;
  quantity: number;
  category: string;
}

// Top-level page with two tabs: New Distribution (the wizard) and History.
export default function Distribute() {
  const { t } = useTranslation();
  const [tab, setTab] = useState<'new' | 'history'>('new');

  return (
    <div className="space-y-5">
      <header>
        <h1 className="text-2xl font-bold flex items-center gap-2">
          <PackageCheck size={22} /> {t('distribute.title')}
        </h1>
      </header>

      <div className="flex border-b border-slate-700 -mt-1">
        <button
          onClick={() => setTab('new')}
          className={`px-4 py-2 -mb-px text-sm font-medium flex items-center gap-2 border-b-2 transition-colors ${
            tab === 'new'
              ? 'border-brand text-brand'
              : 'border-transparent text-slate-400 hover:text-slate-200'
          }`}
        >
          <PackageCheck size={14} />
          {t('distribute.tab_new')}
        </button>
        <button
          onClick={() => setTab('history')}
          className={`px-4 py-2 -mb-px text-sm font-medium flex items-center gap-2 border-b-2 transition-colors ${
            tab === 'history'
              ? 'border-brand text-brand'
              : 'border-transparent text-slate-400 hover:text-slate-200'
          }`}
        >
          <HistoryIcon size={14} />
          {t('distribute.tab_history')}
        </button>
      </div>

      {tab === 'new' ? <DistributionWizard /> : <DistributionHistory />}
    </div>
  );
}

function DistributionWizard() {
  const { t } = useTranslation();
  const nav = useNavigate();
  const user = useAuthStore((s) => s.user);
  const language = useSettingsStore((s) => s.language);

  const [step, setStep] = useState(1);
  const [families, setFamilies] = useState<Family[]>([]);
  const [sector, setSector] = useState('');
  const [selectedFamilyId, setSelectedFamilyId] = useState<string>('');
  const [items, setItems] = useState<LineItem[]>([
    { item_name: 'Family food parcel (15 days)', quantity: 1, category: 'food' },
  ]);
  const [postNotes, setPostNotes] = useState('');
  const [flagNew, setFlagNew] = useState(false);
  const [saving, setSaving] = useState(false);
  const [done, setDone] = useState<{ delta: number; reason: string; new_score: number } | null>(null);

  useEffect(() => {
    void db.families.toArray().then(setFamilies);
  }, []);

  const sectors = useMemo(
    () => Array.from(new Set(families.map((f) => f.location_sector))).sort(),
    [families]
  );

  const sectorFamilies = useMemo(() => {
    const filtered = families.filter((f) => !sector || f.location_sector === sector);
    const ranked: PrioritizationResult[] = sortByScore(filtered.map(computeRuleScore));
    const byId = new Map(ranked.map((r) => [r.family_id, r]));
    return filtered
      .slice()
      .sort((a, b) => (byId.get(b.family_id)!.priority_score - byId.get(a.family_id)!.priority_score))
      .map((f) => ({ family: f, result: byId.get(f.family_id)! }));
  }, [families, sector]);

  const selectedFamily = families.find((f) => f.family_id === selectedFamilyId);
  const daysSinceLastAid = selectedFamily?.last_aid_at
    ? Math.floor((Date.now() - new Date(selectedFamily.last_aid_at).getTime()) / 86_400_000)
    : null;
  const duplicateWarning = daysSinceLastAid !== null && daysSinceLastAid < 3;

  const next = () => setStep((s) => Math.min(4, s + 1));
  const back = () => setStep((s) => Math.max(1, s - 1));

  const updateItem = (i: number, patch: Partial<LineItem>) => {
    setItems((arr) => arr.map((it, idx) => (idx === i ? { ...it, ...patch } : it)));
  };
  const addItem = () => setItems((arr) => [...arr, { item_name: '', quantity: 1, category: 'general' }]);
  const removeItem = (i: number) => setItems((arr) => arr.filter((_, idx) => idx !== i));

  const submit = async () => {
    if (!selectedFamily || !user) return;
    setSaving(true);
    try {
      const oldScore = selectedFamily.priority_score ?? computeRuleScore(selectedFamily).priority_score;
      const distribution: AidDistribution = {
        distribution_id: `D-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        family_id: selectedFamily.family_id,
        session_id: `S-${new Date().toISOString().slice(0, 10)}`,
        items_distributed: items.filter((i) => i.item_name.trim()),
        distributed_by: user.user_id,
        distributed_at: new Date().toISOString(),
        ai_priority_score: oldScore,
        ai_reasoning: selectedFamily.ai_reason ?? '',
        post_update_notes: postNotes,
        new_needs_flagged: flagNew,
      };
      await db.distributions.add(distribution);

      // Recompute priority for the family using Gemma 4 (with rule fallback)
      const updated: Family = {
        ...selectedFamily,
        last_aid_at: new Date().toISOString(),
        new_need_flagged: flagNew,
        last_updated: new Date().toISOString(),
      };
      const recompute = await recomputeAfterUpdate(
        updated,
        oldScore,
        `Items distributed: ${items.map((i) => `${i.item_name} ×${i.quantity}`).join(', ')}. Notes: ${postNotes || '—'}. New need flagged: ${flagNew}.`,
        language
      );
      await db.families.put({
        ...updated,
        priority_score: recompute.new_score,
        priority_level:
          recompute.new_score >= 80 ? 'CRITICAL'
            : recompute.new_score >= 60 ? 'HIGH'
            : recompute.new_score >= 40 ? 'MEDIUM' : 'NORMAL',
        ai_reason: recompute.reason,
      });
      setDone(recompute);
    } finally {
      setSaving(false);
    }
  };

  if (done) {
    return (
      <Card>
        <div className="text-center py-8">
          <CheckCircle2 size={48} className="text-priority-normal mx-auto mb-3" />
          <h2 className="text-xl font-bold">{t('distribute.saved')}</h2>
          <p className="text-sm text-slate-400 mt-2">{done.reason}</p>
          <div className="mt-4 inline-flex items-center gap-3 bg-surface-light px-4 py-2 rounded-lg">
            <span className="text-xs text-slate-400">New score:</span>
            <span className="font-bold text-2xl text-ai">{done.new_score}</span>
            <span className={`text-sm ${done.delta >= 0 ? 'text-priority-high' : 'text-priority-normal'}`}>
              ({done.delta >= 0 ? '+' : ''}{done.delta})
            </span>
          </div>
          <div className="mt-6 flex gap-2 justify-center">
            <button
              onClick={() => {
                setDone(null);
                setStep(2);
                setSelectedFamilyId('');
                setItems([{ item_name: 'Family food parcel (15 days)', quantity: 1, category: 'food' }]);
                setPostNotes('');
                setFlagNew(false);
              }}
              className="touch-target px-4 py-2 bg-brand text-white rounded-lg font-semibold"
            >
              Distribute to next family
            </button>
            <button
              onClick={() => nav('/families')}
              className="touch-target px-4 py-2 bg-surface-light text-slate-200 rounded-lg"
            >
              View families
            </button>
          </div>
        </div>
      </Card>
    );
  }

  return (
    <div className="space-y-5">
      <Stepper step={step} />

      {step === 1 && (
        <Card title={t('distribute.step1')}>
          <select
            value={sector}
            onChange={(e) => setSector(e.target.value)}
            className="w-full bg-surface-deep border border-slate-700 rounded-lg px-3 py-3 text-sm focus:border-brand outline-none touch-target"
          >
            <option value="">{t('distribute.select_sector')}</option>
            {sectors.map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>
          <div className="flex justify-end mt-4">
            <button
              onClick={next}
              disabled={!sector}
              className="touch-target px-4 py-2 bg-brand hover:bg-brand-dark disabled:opacity-50 rounded-lg flex items-center gap-1 font-semibold"
            >
              {t('distribute.next')} <ChevronRight size={16} />
            </button>
          </div>
        </Card>
      )}

      {step === 2 && (
        <Card title={t('distribute.step2')}>
          <ul className="divide-y divide-slate-700 -my-2">
            {sectorFamilies.map(({ family, result }) => (
              <li
                key={family.family_id}
                className={`py-3 flex items-center gap-3 cursor-pointer hover:bg-surface-light px-2 rounded ${
                  selectedFamilyId === family.family_id ? 'bg-brand/10 ring-1 ring-brand/40' : ''
                }`}
                onClick={() => setSelectedFamilyId(family.family_id)}
              >
                <input
                  type="radio"
                  checked={selectedFamilyId === family.family_id}
                  readOnly
                  className="accent-brand"
                />
                <div className="flex-1 min-w-0">
                  <div className="font-medium truncate">{family.head_name}</div>
                  <div className="text-xs text-slate-400 italic line-clamp-1">{result.reason}</div>
                </div>
                <PriorityBadge level={result.priority_level} score={result.priority_score} />
              </li>
            ))}
          </ul>
          <div className="flex justify-between mt-4">
            <button onClick={back} className="touch-target px-4 py-2 bg-surface-light rounded-lg flex items-center gap-1">
              <ChevronLeft size={16} /> {t('distribute.back')}
            </button>
            <button
              onClick={next}
              disabled={!selectedFamilyId}
              className="touch-target px-4 py-2 bg-brand hover:bg-brand-dark disabled:opacity-50 rounded-lg flex items-center gap-1 font-semibold"
            >
              {t('distribute.next')} <ChevronRight size={16} />
            </button>
          </div>
        </Card>
      )}

      {step === 3 && selectedFamily && (
        <Card title={t('distribute.step3')}>
          {duplicateWarning && (
            <div className="flex items-start gap-2 mb-3 p-3 bg-priority-high/10 border border-priority-high/30 rounded-lg text-sm">
              <AlertTriangle size={16} className="text-priority-high flex-shrink-0 mt-0.5" />
              <span>{t('distribute.duplicate_warning', { n: daysSinceLastAid })}</span>
            </div>
          )}
          <div className="text-sm bg-surface-light p-3 rounded-lg mb-4">
            <div className="font-medium">{selectedFamily.head_name}</div>
            <div className="text-xs text-slate-400">
              {selectedFamily.family_id} · {selectedFamily.location_sector}
            </div>
          </div>

          <h3 className="text-sm font-medium mb-2">{t('distribute.items')}</h3>
          <div className="space-y-2">
            {items.map((it, i) => (
              <div key={i} className="flex gap-2 items-center">
                <select
                  value={it.item_name}
                  onChange={(e) => {
                    const tmpl = ITEM_TEMPLATES.find((tt) => tt.name === e.target.value);
                    updateItem(i, {
                      item_name: e.target.value,
                      category: tmpl?.category ?? it.category,
                    });
                  }}
                  className="flex-1 bg-surface-deep border border-slate-700 rounded-lg px-2 py-2 text-sm touch-target"
                >
                  <option value="">— {t('distribute.add_item')} —</option>
                  {ITEM_TEMPLATES.map((tmpl) => (
                    <option key={tmpl.name} value={tmpl.name}>{tmpl.name}</option>
                  ))}
                </select>
                <input
                  type="number"
                  min={1}
                  value={it.quantity}
                  onChange={(e) => updateItem(i, { quantity: Math.max(1, +e.target.value) })}
                  className="w-20 bg-surface-deep border border-slate-700 rounded-lg px-2 py-2 text-sm touch-target text-center"
                />
                <button
                  onClick={() => removeItem(i)}
                  className="touch-target p-2 hover:bg-red-500/10 hover:text-red-400 rounded-lg"
                >
                  <X size={16} />
                </button>
              </div>
            ))}
            <button
              onClick={addItem}
              className="text-sm text-brand hover:underline flex items-center gap-1"
            >
              <Plus size={14} /> {t('distribute.add_item')}
            </button>
          </div>
          <div className="flex justify-between mt-5">
            <button onClick={back} className="touch-target px-4 py-2 bg-surface-light rounded-lg flex items-center gap-1">
              <ChevronLeft size={16} /> {t('distribute.back')}
            </button>
            <button
              onClick={next}
              disabled={!items.some((i) => i.item_name.trim())}
              className="touch-target px-4 py-2 bg-brand disabled:opacity-50 rounded-lg flex items-center gap-1 font-semibold"
            >
              {t('distribute.next')} <ChevronRight size={16} />
            </button>
          </div>
        </Card>
      )}

      {step === 4 && selectedFamily && (
        <Card title={t('distribute.step4')}>
          <div>
            <label className="block text-xs text-slate-400 mb-1.5 font-medium">
              {t('distribute.post_notes')}
            </label>
            <textarea
              value={postNotes}
              onChange={(e) => setPostNotes(e.target.value)}
              rows={3}
              className="w-full bg-surface-deep border border-slate-700 rounded-lg px-3 py-2 text-sm focus:border-brand outline-none"
              placeholder="e.g. Family in good order. Mother reported child with fever."
            />
          </div>
          <label className="mt-3 flex items-center gap-2 text-sm cursor-pointer">
            <input
              type="checkbox"
              checked={flagNew}
              onChange={(e) => setFlagNew(e.target.checked)}
              className="accent-priority-critical"
            />
            <AlertTriangle size={14} className="text-priority-critical" />
            {t('distribute.flag_new_need')}
          </label>
          <div className="flex justify-between mt-5">
            <button onClick={back} className="touch-target px-4 py-2 bg-surface-light rounded-lg flex items-center gap-1">
              <ChevronLeft size={16} /> {t('distribute.back')}
            </button>
            <button
              onClick={() => void submit()}
              disabled={saving}
              className="touch-target px-4 py-2 bg-priority-normal hover:bg-emerald-600 disabled:opacity-60 rounded-lg flex items-center gap-2 font-semibold"
            >
              {saving ? <Loading /> : <CheckCircle2 size={16} />}
              {t('distribute.save_update')}
            </button>
          </div>
        </Card>
      )}
    </div>
  );
}

function Stepper({ step }: { step: number }) {
  const { t } = useTranslation();
  const labels = [t('distribute.step1'), t('distribute.step2'), t('distribute.step3'), t('distribute.step4')];
  return (
    <ol className="flex flex-wrap items-center gap-2 text-xs mt-3">
      {labels.map((label, i) => (
        <li key={i} className="flex items-center gap-2">
          <span
            className={`w-6 h-6 rounded-full grid place-items-center font-semibold ${
              i + 1 <= step ? 'bg-brand text-white' : 'bg-surface-light text-slate-400'
            }`}
          >
            {i + 1}
          </span>
          <span className={i + 1 <= step ? 'text-slate-200' : 'text-slate-500'}>{label}</span>
          {i < labels.length - 1 && <span className="text-slate-600 mx-1">›</span>}
        </li>
      ))}
    </ol>
  );
}

// =========================================================================
// History tab
// =========================================================================

function DistributionHistory() {
  const { t } = useTranslation();

  // Live data from IndexedDB — auto-refreshes when a new distribution is recorded
  const distributions = useLiveQuery(() => db.distributions.toArray()) ?? [];
  const families = useLiveQuery(() => db.families.toArray()) ?? [];
  const users = useLiveQuery(() => db.users.toArray()) ?? [];

  // Filters
  const [sector, setSector] = useState('');
  const [worker, setWorker] = useState('');
  const [flag, setFlag] = useState<'all' | 'yes' | 'no'>('all');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [search, setSearch] = useState('');

  const sectors = useMemo(
    () => Array.from(new Set(families.map((f) => f.location_sector))).sort(),
    [families]
  );

  const familyMap = useMemo(() => new Map(families.map((f) => [f.family_id, f])), [families]);
  const userMap = useMemo(() => new Map(users.map((u) => [u.user_id, u])), [users]);

  const filtered = useMemo(() => {
    let list = [...distributions];
    if (sector) {
      list = list.filter((d) => familyMap.get(d.family_id)?.location_sector === sector);
    }
    if (worker) {
      list = list.filter((d) => d.distributed_by === worker);
    }
    if (flag === 'yes') list = list.filter((d) => d.new_needs_flagged);
    else if (flag === 'no') list = list.filter((d) => !d.new_needs_flagged);
    if (from) {
      list = list.filter((d) => d.distributed_at.slice(0, 10) >= from);
    }
    if (to) {
      list = list.filter((d) => d.distributed_at.slice(0, 10) <= to);
    }
    if (search.trim()) {
      const q = search.trim().toLowerCase();
      list = list.filter((d) => {
        const fam = familyMap.get(d.family_id);
        return (
          fam?.head_name.toLowerCase().includes(q) ||
          d.family_id.toLowerCase().includes(q) ||
          d.post_update_notes?.toLowerCase().includes(q) ||
          d.items_distributed.some((it) => it.item_name.toLowerCase().includes(q))
        );
      });
    }
    return list.sort((a, b) => b.distributed_at.localeCompare(a.distributed_at));
  }, [distributions, familyMap, sector, worker, flag, from, to, search]);

  const totalItems = filtered.reduce(
    (s, d) => s + d.items_distributed.reduce((a, b) => a + b.quantity, 0),
    0
  );
  const uniqueFamilies = new Set(filtered.map((d) => d.family_id)).size;

  const clearFilters = () => {
    setSector('');
    setWorker('');
    setFlag('all');
    setFrom('');
    setTo('');
    setSearch('');
  };

  const exportCSV = () => {
    const headers = [
      'distribution_id',
      'family_id',
      'family_name',
      'sector',
      'distributed_at',
      'distributed_by',
      'distributed_by_name',
      'items',
      'quantity_total',
      'priority_score',
      'flagged',
      'notes',
    ];
    const rows = filtered.map((d) => {
      const fam = familyMap.get(d.family_id);
      const u = userMap.get(d.distributed_by);
      return [
        d.distribution_id,
        d.family_id,
        fam?.head_name ?? '',
        fam?.location_sector ?? '',
        d.distributed_at,
        d.distributed_by,
        u?.name ?? '',
        d.items_distributed.map((i) => `${i.item_name} x${i.quantity}`).join('; '),
        d.items_distributed.reduce((a, b) => a + b.quantity, 0),
        d.ai_priority_score,
        d.new_needs_flagged ? 'yes' : '',
        d.post_update_notes ?? '',
      ].map((v) => `"${String(v).replaceAll('"', '""')}"`);
    });
    const csv = [headers.join(','), ...rows.map((r) => r.join(','))].join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `aidflow-history-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const hasActiveFilter = sector || worker || flag !== 'all' || from || to || search.trim();

  return (
    <div className="space-y-4">
      {/* Filters */}
      <Card title={t('distribute.history_title')}>
        <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
          <div>
            <label className="block text-xs text-slate-400 mb-1 font-medium">
              {t('families.sector')}
            </label>
            <select
              value={sector}
              onChange={(e) => setSector(e.target.value)}
              className="w-full bg-surface-deep border border-slate-700 rounded-lg px-3 py-2 text-sm focus:border-brand outline-none"
            >
              <option value="">{t('distribute.filter_sector_all')}</option>
              {sectors.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-xs text-slate-400 mb-1 font-medium">Worker</label>
            <select
              value={worker}
              onChange={(e) => setWorker(e.target.value)}
              className="w-full bg-surface-deep border border-slate-700 rounded-lg px-3 py-2 text-sm focus:border-brand outline-none"
            >
              <option value="">{t('distribute.filter_worker_all')}</option>
              {users.map((u) => (
                <option key={u.user_id} value={u.user_id}>
                  {u.name} ({u.role.replace('_', ' ')})
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-xs text-slate-400 mb-1 font-medium flex items-center gap-1">
              <Flag size={12} /> Flag
            </label>
            <select
              value={flag}
              onChange={(e) => setFlag(e.target.value as 'all' | 'yes' | 'no')}
              className="w-full bg-surface-deep border border-slate-700 rounded-lg px-3 py-2 text-sm focus:border-brand outline-none"
            >
              <option value="all">{t('distribute.filter_flag_all')}</option>
              <option value="yes">{t('distribute.filter_flag_yes')}</option>
              <option value="no">{t('distribute.filter_flag_no')}</option>
            </select>
          </div>

          <div>
            <label className="block text-xs text-slate-400 mb-1 font-medium flex items-center gap-1">
              <Calendar size={12} /> {t('distribute.filter_from')}
            </label>
            <input
              type="date"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
              className="w-full bg-surface-deep border border-slate-700 rounded-lg px-3 py-2 text-sm focus:border-brand outline-none"
            />
          </div>

          <div>
            <label className="block text-xs text-slate-400 mb-1 font-medium flex items-center gap-1">
              <Calendar size={12} /> {t('distribute.filter_to')}
            </label>
            <input
              type="date"
              value={to}
              onChange={(e) => setTo(e.target.value)}
              className="w-full bg-surface-deep border border-slate-700 rounded-lg px-3 py-2 text-sm focus:border-brand outline-none"
            />
          </div>

          <div>
            <label className="block text-xs text-slate-400 mb-1 font-medium flex items-center gap-1">
              <Search size={12} /> Search
            </label>
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t('distribute.filter_search')}
              className="w-full bg-surface-deep border border-slate-700 rounded-lg px-3 py-2 text-sm focus:border-brand outline-none"
            />
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2 mt-4 pt-4 border-t border-slate-700">
          <span className="text-xs text-slate-400">
            {t('distribute.history_count', {
              count: filtered.length,
              items: totalItems,
              families: uniqueFamilies,
            })}
          </span>
          <div className="ms-auto flex gap-2">
            {hasActiveFilter && (
              <button
                onClick={clearFilters}
                className="touch-target px-3 py-1.5 bg-surface-light hover:bg-slate-600 rounded-lg text-xs flex items-center gap-1"
              >
                <X size={12} /> {t('distribute.filter_clear')}
              </button>
            )}
            <button
              onClick={exportCSV}
              disabled={filtered.length === 0}
              className="touch-target px-3 py-1.5 bg-brand hover:bg-brand-dark disabled:opacity-50 rounded-lg text-xs flex items-center gap-1 font-semibold"
            >
              <Download size={12} /> {t('distribute.export_csv')}
            </button>
          </div>
        </div>
      </Card>

      {/* List */}
      {filtered.length === 0 ? (
        <Card>
          <EmptyState
            icon={<HistoryIcon size={28} />}
            title={t('distribute.history_empty')}
          />
        </Card>
      ) : (
        <div className="space-y-2">
          {filtered.map((d) => (
            <HistoryRow
              key={d.distribution_id}
              distribution={d}
              family={familyMap.get(d.family_id)}
              worker={userMap.get(d.distributed_by)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function HistoryRow({
  distribution,
  family,
  worker,
}: {
  distribution: AidDistribution;
  family?: Family;
  worker?: User;
}) {
  const [expanded, setExpanded] = useState(false);
  const totalQty = distribution.items_distributed.reduce((a, b) => a + b.quantity, 0);
  return (
    <article
      className="bg-surface border border-slate-700 hover:border-brand/40 rounded-xl p-4 transition-colors cursor-pointer"
      onClick={() => setExpanded(!expanded)}
    >
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            {family ? (
              <Link
                to={`/families/${family.family_id}`}
                onClick={(e) => e.stopPropagation()}
                className="font-semibold hover:text-brand transition-colors"
              >
                {family.head_name}
              </Link>
            ) : (
              <span className="font-semibold text-slate-400">
                Unknown family
              </span>
            )}
            <span className="text-xs text-slate-500">{distribution.family_id}</span>
            {distribution.new_needs_flagged && (
              <span className="text-[10px] px-2 py-0.5 rounded-full bg-priority-critical/20 text-priority-critical font-semibold flex items-center gap-1">
                <Flag size={10} /> NEW NEED
              </span>
            )}
          </div>
          <div className="text-xs text-slate-400 mt-1 flex flex-wrap gap-x-3 gap-y-0.5">
            <span>
              <Calendar size={11} className="inline me-1" />
              {new Date(distribution.distributed_at).toLocaleString()}
            </span>
            {family?.location_sector && <span>{family.location_sector}</span>}
            <span>by {worker?.name ?? distribution.distributed_by}</span>
            <span>
              {distribution.items_distributed.length} item type
              {distribution.items_distributed.length === 1 ? '' : 's'} · {totalQty} total
            </span>
          </div>
          <div className="text-xs text-slate-300 mt-1 line-clamp-1">
            {distribution.items_distributed
              .map((i) => `${i.item_name} ×${i.quantity}`)
              .join(', ')}
          </div>
        </div>
        <PriorityBadge
          level={
            distribution.ai_priority_score >= 80
              ? 'CRITICAL'
              : distribution.ai_priority_score >= 60
              ? 'HIGH'
              : distribution.ai_priority_score >= 40
              ? 'MEDIUM'
              : 'NORMAL'
          }
          score={distribution.ai_priority_score}
          size="sm"
        />
      </div>

      {expanded && (
        <div className="mt-3 pt-3 border-t border-slate-700 space-y-2 text-xs">
          {distribution.ai_reasoning && (
            <div>
              <div className="text-slate-400 font-medium mb-0.5">AI reasoning at time of distribution</div>
              <div className="text-slate-200 italic">{distribution.ai_reasoning}</div>
            </div>
          )}
          {distribution.post_update_notes && (
            <div>
              <div className="text-slate-400 font-medium mb-0.5">Post-delivery notes</div>
              <div className="bg-surface-light px-2 py-1 rounded text-slate-200">
                {distribution.post_update_notes}
              </div>
            </div>
          )}
          <div>
            <div className="text-slate-400 font-medium mb-0.5">Items</div>
            <ul className="space-y-0.5">
              {distribution.items_distributed.map((it, i) => (
                <li key={i} className="flex justify-between bg-surface-deep px-2 py-1 rounded">
                  <span>{it.item_name}</span>
                  <span className="text-slate-400">
                    ×{it.quantity} · {it.category}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}
    </article>
  );
}
