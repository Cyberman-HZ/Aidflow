import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import {
  PackageCheck,
  ChevronRight,
  ChevronLeft,
  AlertTriangle,
  Plus,
  X,
  CheckCircle2,
} from 'lucide-react';
import { db } from '@/db/database';
import { Card } from '@/components/Card';
import PriorityBadge from '@/components/PriorityBadge';
import Loading from '@/components/Loading';
import { computeRuleScore, sortByScore } from '@/services/priorityRules';
import { recomputeAfterUpdate } from '@/services/ollama';
import { useAuthStore } from '@/stores/authStore';
import { useSettingsStore } from '@/stores/settingsStore';
import type { Family, AidDistribution, PrioritizationResult } from '@/types';

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

export default function Distribute() {
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
      <header>
        <h1 className="text-2xl font-bold flex items-center gap-2">
          <PackageCheck size={22} /> {t('distribute.title')}
        </h1>
        <Stepper step={step} />
      </header>

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
