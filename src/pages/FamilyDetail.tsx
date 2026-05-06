import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useParams } from 'react-router-dom';
import {
  ArrowLeft,
  MapPin,
  Heart,
  Users,
  Baby,
  Sparkles,
  Calendar,
  CheckCircle2,
  Edit2,
  X,
  Package,
} from 'lucide-react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '@/db/database';
import { computeRuleScore } from '@/services/priorityRules';
import { Card } from '@/components/Card';
import PriorityBadge from '@/components/PriorityBadge';
import StatusBadge from '@/components/StatusBadge';
import EmptyState from '@/components/EmptyState';
import AIChat from '@/components/AIChat';
import FamilyEditModal from '@/components/FamilyEditModal';
import type { Family, AidDistribution } from '@/types';

export default function FamilyDetail() {
  const { id } = useParams();
  const { t } = useTranslation();
  const [editing, setEditing] = useState(false);

  const family = useLiveQuery(
    () => (id ? db.families.get(id) : undefined),
    [id]
  ) as Family | undefined;
  const history =
    useLiveQuery(
      () =>
        id
          ? db.distributions
              .where('family_id')
              .equals(id)
              .toArray()
              .then((rows) =>
                rows.sort((a, b) =>
                  (b.delivered_at ?? b.created_at ?? '').localeCompare(
                    a.delivered_at ?? a.created_at ?? ''
                  )
                )
              )
          : Promise.resolve([] as AidDistribution[]),
      [id]
    ) ?? [];

  if (!family) {
    return (
      <div>
        <Link to="/families" className="text-sm text-brand hover:underline inline-flex items-center gap-1">
          <ArrowLeft size={14} /> Families
        </Link>
        <Card><EmptyState title="Family not found" /></Card>
      </div>
    );
  }

  // Recompute live so the badge reflects the freshest signals (delivery
  // history, items list, etc.) without waiting for the cached fields on the
  // family row to be re-saved. We still fall back to the cache when the
  // recomputed value matches; this is a pure function so it's cheap.
  const rule = computeRuleScore(family, history);
  const score = rule.priority_score;
  const level = rule.priority_level;
  const recommended = family.recommended_items ?? rule.recommended_items;

  return (
    <div className="space-y-5">
      <Link to="/families" className="text-sm text-brand hover:underline inline-flex items-center gap-1">
        <ArrowLeft size={14} /> {t('families.title')}
      </Link>

      <header className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold">{family.head_name}</h1>
          <div className="text-sm text-slate-400 flex flex-wrap items-center gap-x-2 gap-y-0.5">
            <span>{t('family_detail.title', { id: family.family_id })}</span>
            <span>·</span>
            <span><MapPin size={12} className="inline" /> {family.location_sector}</span>
            <span>·</span>
            <LastAidIndicator lastAidAt={family.last_aid_at} />
          </div>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <button
            onClick={() => setEditing(true)}
            className="touch-target px-3 py-2 bg-surface-light hover:bg-brand hover:text-white border border-slate-700 hover:border-brand rounded-lg text-sm font-medium flex items-center gap-2 transition-colors"
          >
            <Edit2 size={14} /> {t('family_detail.edit')}
          </button>
          <PriorityBadge level={level} score={score} size="lg" />
        </div>
      </header>

      <div className="grid lg:grid-cols-3 gap-5">
        <Card title={t('family_detail.demographics')} className="lg:col-span-1">
          <dl className="space-y-3 text-sm">
            <Row icon={<Users size={14} />} label={t('families.members')} value={family.member_count} />
            <Row icon={<Baby size={14} />} label={t('families.children_under5')} value={family.children_under_5} />
            <Row icon={<Heart size={14} />} label={t('families.elderly')} value={family.elderly_count} />
            {family.has_pregnant_member && (
              <Row icon={<Heart size={14} />} label={t('families.pregnant')} value="Yes" />
            )}
            <Row label={t('family_detail.displacement')} value={family.displacement_status} />
            <Row label={t('family_detail.income')} value={family.income_level} />
            {family.street && (
              <Row icon={<MapPin size={14} />} label={t('families_edit.street')} value={family.street} />
            )}
            {family.city && (
              <Row icon={<MapPin size={14} />} label={t('families_edit.city')} value={family.city} />
            )}
          </dl>
        </Card>

        <Card title={t('family_detail.medical')} className="lg:col-span-2">
          {family.medical_conditions.length === 0 ? (
            <p className="text-sm text-slate-400">No medical conditions on record.</p>
          ) : (
            <ul className="text-sm space-y-1.5">
              {family.medical_conditions.map((c, i) => (
                <li
                  key={i}
                  className={`px-3 py-2 rounded-lg border ${
                    c.toLowerCase().includes('critical')
                      ? 'bg-priority-critical/10 border-priority-critical/30 text-priority-critical'
                      : 'bg-surface-light border-slate-700'
                  }`}
                >
                  {c}
                </li>
              ))}
            </ul>
          )}
          {family.last_medical_notes && (
            <div className="mt-4 pt-4 border-t border-slate-700">
              <div className="text-xs text-slate-400 mb-1 font-medium flex items-center gap-1">
                <Heart size={11} /> Last medical notes (from latest delivery)
              </div>
              <p className="text-sm text-slate-200 italic">{family.last_medical_notes}</p>
            </div>
          )}
          {family.last_delivery_notes && (
            <div className="mt-4 pt-4 border-t border-slate-700">
              <div className="text-xs text-slate-400 mb-1 font-medium">
                Last delivery notes
              </div>
              <p className="text-sm text-slate-200 italic">{family.last_delivery_notes}</p>
            </div>
          )}
          {family.notes && (
            <div className="mt-4 pt-4 border-t border-slate-700">
              <div className="text-xs text-slate-400 mb-1 font-medium">Field notes</div>
              <p className="text-sm text-slate-200">{family.notes}</p>
            </div>
          )}
        </Card>
      </div>

      <CurrentNeedsCard family={family} fallbackItems={recommended} />

      <div className="grid lg:grid-cols-2 gap-5 lg:items-stretch">
        <Card title={t('family_detail.history')}>
          {history.length === 0 ? (
            <EmptyState title={t('family_detail.no_history')} icon={<Calendar size={24} />} />
          ) : (
            <ul className="divide-y divide-slate-700">
              {history.map((d) => (
                <li key={d.distribution_id} className="py-3">
                  <div className="flex items-start justify-between gap-2 flex-wrap">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-1">
                        <StatusBadge status={d.status} size="sm" />
                        <span className="text-xs text-slate-500">{d.distribution_id}</span>
                      </div>
                      <div className="text-sm">
                        {d.items_distributed.map((i) => `${i.item_name} ×${i.quantity}`).join(', ')}
                      </div>
                      <div className="text-xs text-slate-400 mt-0.5">
                        {new Date(d.delivered_at ?? d.created_at ?? '').toLocaleDateString()}{' '}
                        · {d.delivered_by ?? d.assigned_to ?? d.distributed_by ?? '—'}
                      </div>
                    </div>
                    <PriorityBadge
                      level={
                        d.ai_priority_score >= 80 ? 'CRITICAL'
                          : d.ai_priority_score >= 60 ? 'HIGH'
                          : d.ai_priority_score >= 40 ? 'MEDIUM' : 'NORMAL'
                      }
                      score={d.ai_priority_score}
                      size="sm"
                    />
                  </div>
                  {d.post_update_notes && (
                    <p className="text-xs text-slate-300 mt-1.5 bg-surface-light px-3 py-1.5 rounded">
                      {d.post_update_notes}
                    </p>
                  )}
                  {d.failure_reason && (
                    <p className="text-xs text-priority-critical mt-1.5 italic">
                      {d.status === 'failed' ? 'Failed: ' : 'Cancelled: '}{d.failure_reason}
                    </p>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Card>

        <div className="flex flex-col">
          <h3 className="text-sm font-semibold text-slate-300 mb-2 flex items-center gap-2">
            <Sparkles size={14} className="text-ai" />
            {t('family_detail.ask_about')}
          </h3>
          <AIChat
            systemPrompt={`You are AidFlow Pro's AI assistant powered by Gemma 4. You are answering questions about family ${family.family_id} (${family.head_name}). Current family data (use it as the source of truth — do NOT invent fields): ${JSON.stringify(family)}. Be concise, practical, and reference the family's specific situation. When the user asks for a change to this family's record, propose it as an action block (see ACTIONS section below) — never claim a change has already happened.`}
            contextLabel={`Family ${family.family_id} — ${family.head_name}`}
            placeholder={t('assistant.placeholder')}
            family={family}
          />
        </div>
      </div>

      {editing && (
        <FamilyEditModal
          existing={family}
          onClose={() => setEditing(false)}
        />
      )}
    </div>
  );
}

// Current-needs card with inline edit support. The "items" are stored on
// family.recommended_items and surface as "Suggested needs" badges in the
// distribution wizard's step 3, so editing them here changes what the
// wizard suggests for this family next time.
function CurrentNeedsCard({
  family,
  fallbackItems,
}: {
  family: Family;
  fallbackItems: string[];
}) {
  const { t } = useTranslation();
  // An explicit empty array means "no current needs" (e.g. the worker just
  // cleared them on delivery) and must be honoured. Only fall back to the
  // rule-engine suggestions when the family has never had items set.
  const items =
    family.recommended_items !== undefined
      ? family.recommended_items
      : fallbackItems;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<string[]>(items);
  const [draftInput, setDraftInput] = useState('');
  const [saving, setSaving] = useState(false);

  const startEdit = () => {
    setDraft(items);
    setDraftInput('');
    setEditing(true);
  };

  const addDraftItem = () => {
    const v = draftInput.trim();
    if (!v) return;
    if (draft.some((x) => x.toLowerCase() === v.toLowerCase())) {
      setDraftInput('');
      return;
    }
    setDraft((arr) => [...arr, v]);
    setDraftInput('');
  };
  const removeDraftItem = (i: number) =>
    setDraft((arr) => arr.filter((_, idx) => idx !== i));

  const save = async () => {
    setSaving(true);
    try {
      await db.families.update(family.family_id, {
        recommended_items: draft,
        last_updated: new Date().toISOString(),
      });
      setEditing(false);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card
      title={
        <div className="flex items-center gap-2">
          <Package size={14} className="text-brand" />
          {t('family_detail.current_needs')}
        </div>
      }
      action={
        editing ? null : (
          <button
            onClick={startEdit}
            className="touch-target px-2.5 py-1 hover:bg-surface-light text-slate-300 hover:text-brand rounded-md text-xs flex items-center gap-1"
          >
            <Edit2 size={12} /> {t('family_detail.edit_needs')}
          </button>
        )
      }
    >
      {editing ? (
        <div className="space-y-3">
          <div className="flex flex-wrap gap-1.5">
            {draft.map((it, i) => (
              <span
                key={i}
                className="text-xs bg-brand/15 text-brand border border-brand/30 px-2 py-1 rounded-full flex items-center gap-1"
              >
                {it}
                <button
                  onClick={() => removeDraftItem(i)}
                  aria-label={`Remove ${it}`}
                  className="hover:text-white"
                >
                  <X size={11} />
                </button>
              </span>
            ))}
            {draft.length === 0 && (
              <span className="text-xs text-slate-500 italic">
                {t('family_detail.no_needs_yet')}
              </span>
            )}
          </div>
          <div className="flex gap-1.5">
            <input
              value={draftInput}
              onChange={(e) => setDraftInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  addDraftItem();
                }
              }}
              placeholder={t('family_detail.add_need_placeholder') ?? ''}
              className="flex-1 bg-surface-deep border border-slate-700 rounded-lg px-3 py-2 text-sm focus:border-brand outline-none"
            />
            <button
              onClick={addDraftItem}
              disabled={!draftInput.trim()}
              className="touch-target px-3 py-2 bg-surface-light hover:bg-slate-600 disabled:opacity-40 rounded-lg text-xs flex items-center gap-1"
            >
              + {t('distribute.add_item')}
            </button>
          </div>
          <div className="flex gap-2 pt-1 border-t border-slate-700">
            <button
              onClick={() => void save()}
              disabled={saving}
              className="touch-target px-4 py-2 bg-brand hover:bg-brand-dark disabled:opacity-50 text-white rounded-lg text-sm font-semibold flex items-center gap-1"
            >
              {saving ? t('common.saving') : t('common.save')}
            </button>
            <button
              onClick={() => setEditing(false)}
              disabled={saving}
              className="touch-target px-4 py-2 bg-surface-light hover:bg-slate-600 disabled:opacity-50 rounded-lg text-sm flex items-center gap-1"
            >
              {t('common.cancel')}
            </button>
          </div>
        </div>
      ) : items.length === 0 ? (
        <p className="text-sm text-slate-500 italic">
          {t('family_detail.no_needs_yet')}
        </p>
      ) : (
        <div className="flex flex-wrap gap-2">
          {items.map((item) => (
            <span
              key={item}
              className="text-xs bg-brand/15 text-brand border border-brand/30 px-2 py-1 rounded-full"
            >
              {item}
            </span>
          ))}
        </div>
      )}
    </Card>
  );
}

function LastAidIndicator({ lastAidAt }: { lastAidAt?: string }) {
  if (!lastAidAt) {
    return <span className="text-priority-medium">Last aid: never</span>;
  }
  const days = Math.floor((Date.now() - new Date(lastAidAt).getTime()) / 86_400_000);
  const label =
    days <= 0 ? 'served today' : days === 1 ? 'served yesterday' : `${days}d ago`;
  const colorClass =
    days < 3 ? 'text-priority-normal' : days < 7 ? 'text-priority-medium' : 'text-priority-high';
  return (
    <span className={`flex items-center gap-1 ${colorClass}`}>
      {days < 3 && <CheckCircle2 size={12} />}
      Last aid: {label}
    </span>
  );
}

function Row({
  icon,
  label,
  value,
}: {
  icon?: React.ReactNode;
  label: string;
  value: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <dt className="text-slate-400 capitalize flex items-center gap-2">
        {icon}
        {label.replace('_', ' ')}
      </dt>
      <dd className="text-slate-100 font-medium">{value}</dd>
    </div>
  );
}
