import React, { useRef, useState } from 'react';
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
import EditableDemographicsCard from '@/components/EditableDemographicsCard';
import EditableMedicalCard from '@/components/EditableMedicalCard';
import type { AidDistribution, Family, NeededItem } from '@/types';

export default function FamilyDetail() {
  const { id } = useParams();
  const { t } = useTranslation();

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
          <ArrowLeft size={14} /> {t('families.title')}
        </Link>
        <Card>
          <EmptyState title={t('family_detail.not_found') ?? 'Family not found'} />
        </Card>
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
  // The family row is the single source of truth for current needs.
  // No rule-engine fallback: imports (CSV / photo) leave this field
  // undefined when the source never provided items, and we must not
  // invent needs the admin never entered. An undefined or empty list
  // renders as the "no items yet" empty state on the card.
  const recommended: NeededItem[] = family.recommended_items ?? [];
  // Pass-through snapshot for AIChat so the model sees the same list
  // the chips show. Empty here means truly empty.
  const familyForAI: Family = {
    ...family,
    recommended_items: recommended,
  };

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
          <PriorityBadge level={level} score={score} size="lg" />
        </div>
      </header>

      <>
      <div className="grid lg:grid-cols-3 gap-5">
        <EditableDemographicsCard family={family} />
        <EditableMedicalCard family={family} />
      </div>

      <CurrentNeedsCard family={family} />

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
            systemPrompt={`You are AidFlow Pro's AI assistant for family ${family.family_id} (${family.head_name}).

==========================================================
🟢 CURRENT NEED ITEMS — THE EXACT LIST (matches the chips on screen):
${
  // Use `recommended` — the exact list stored on the family row. No
  // rule-engine fallback here either, so the AI sees what's actually
  // in the DB instead of auto-suggested items the admin never entered.
  recommended.length > 0
    ? recommended
        .map((it, i) => `  ${i + 1}. ${it.name} (quantity: ${it.quantity})`)
        .join('\n')
    : '  (this family has no current need items)'
}
==========================================================

When the user mentions any item from the list above (case-insensitive substring match), it IS in this family's needs — DO NOT deny it. Use the action block to add/remove/decrement it.

Family demographics: ${family.member_count} members, ${family.children_under_5} children<5, ${family.elderly_count} elderly${family.has_pregnant_member ? ', has pregnant/nursing member' : ''}. Sector: ${family.location_sector}. Displacement: ${family.displacement_status}. Income: ${family.income_level}. Medical: ${family.medical_conditions.length === 0 ? 'none' : family.medical_conditions.join(', ')}.

DISTRIBUTION HISTORY: this family has ${history.length} distribution record(s) on file (delivered, failed, cancelled, pending, or out for delivery). The full per-row details — date, status, items+quantities, who delivered, failure reason — are embedded in every user turn under "recent_distributions" in the FAMILY CONTEXT block. When the user asks about past deliveries, last aid date, items previously given, who delivered them, or any history question, ANSWER FROM THOSE ROWS. Do NOT say you have no access — the records are right there.

Be concise. Reference the family's specific situation. When the user asks for a change, propose it as an action block (see ACTIONS section below) — do not claim a change is already done.`}
            contextLabel={`Family ${family.family_id} — ${family.head_name}`}
            placeholder={t('assistant.placeholder')}
            family={familyForAI}
            history={history}
            enableTools
          />
        </div>
      </div>

      </>
    </div>
  );
}

// Current-needs card with inline edit support. The "items" are stored on
// family.recommended_items as { name, quantity } objects and surface as
// "Suggested needs" in the distribute wizard's step 3 — editing them here
// changes what the wizard suggests for this family next time.
//
// No rule-engine fallback here. If `recommended_items` is undefined or
// empty, the card renders its empty state ("No items yet — click Edit to
// add some.") instead of auto-inventing needs from demographics. This is
// the rule that matches user expectation: items appear only when an
// admin or a delivery worker actually entered them.
function CurrentNeedsCard({
  family,
}: {
  family: Family;
}) {
  const { t } = useTranslation();
  const items: NeededItem[] = family.recommended_items ?? [];
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<NeededItem[]>(items);
  const [draftName, setDraftName] = useState('');
  const [draftQty, setDraftQty] = useState(1);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [qtyError, setQtyError] = useState<string | null>(null);
  // Synchronous re-entrancy guard. `disabled={saving}` is a render-side
  // gate — it doesn't stop a programmatic / screen-reader / batched-React
  // double-trigger from queuing two concurrent db.families.update calls.
  // The ref is checked inside save() before any await so duplicates are
  // dropped at the function boundary. Mirrors the pattern in Distribute.
  const busyRef = useRef(false);

  const startEdit = () => {
    setDraft(items.map((i) => ({ ...i })));
    setDraftName('');
    setDraftQty(1);
    setEditing(true);
  };

  const addDraftItem = () => {
    const name = draftName.trim();
    if (!name) {
      setQtyError('Item name is required');
      return;
    }
    if (!Number.isFinite(draftQty) || draftQty < 1) {
      setQtyError('Quantity must be 1 or more');
      return;
    }
    setQtyError(null);
    const qty = Math.max(1, Math.floor(draftQty));
    const idx = draft.findIndex((x) => x.name.toLowerCase() === name.toLowerCase());
    if (idx >= 0) {
      setDraft((arr) =>
        arr.map((it, i) => (i === idx ? { ...it, quantity: it.quantity + qty } : it))
      );
    } else {
      setDraft((arr) => [...arr, { name, quantity: qty }]);
    }
    setDraftName('');
    setDraftQty(1);
  };
  const removeDraftItem = (i: number) =>
    setDraft((arr) => arr.filter((_, idx) => idx !== i));
  const updateDraftQty = (i: number, qty: number) => {
    if (!Number.isFinite(qty) || qty < 1) {
      setQtyError('Quantity must be 1 or more — clamped to 1');
    } else {
      setQtyError(null);
    }
    setDraft((arr) =>
      arr.map((it, idx) =>
        idx === i ? { ...it, quantity: Math.max(1, Math.floor(qty || 1)) } : it
      )
    );
  };

  const save = async () => {
    if (busyRef.current) return; // drop duplicate save while one is in flight
    busyRef.current = true;
    setSaving(true);
    setSaveError(null);
    try {
      await db.families.update(family.family_id, {
        recommended_items: draft,
        last_updated: new Date().toISOString(),
      });
      setEditing(false);
    } catch (e) {
      const raw = e instanceof Error ? e.message : String(e);
      // Map common Dexie / IndexedDB error names to user-friendly messages.
      // The fallback exposes the raw text only as a last resort — if you
      // see it in the wild, add the new error name to one of the buckets.
      let friendly: string;
      if (/QuotaExceeded/i.test(raw)) {
        friendly =
          'Could not save — your device is out of storage. Free up some space and try again.';
      } else if (/InvalidState|Aborted|NotFound|VersionError/i.test(raw)) {
        friendly =
          'Could not save — the database is in an unexpected state. Try refreshing the page.';
      } else if (/Constraint|Data\s?Error/i.test(raw)) {
        friendly =
          'Could not save — one of the values is invalid for the database schema.';
      } else if (/NotAllowed|Security/i.test(raw)) {
        friendly =
          'Could not save — the browser blocked access to local storage (private mode?).';
      } else if (/Timeout|Transaction/i.test(raw)) {
        friendly =
          'Could not save — the save took too long. Check your connection and try again.';
      } else {
        friendly = `Could not save the changes. ${raw}`;
      }
      setSaveError(friendly);
      // eslint-disable-next-line no-console
      console.error('[CurrentNeedsCard] save failed', e);
    } finally {
      setSaving(false);
      busyRef.current = false;
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
          {draft.length === 0 ? (
            <span className="text-xs text-slate-500 italic">
              {t('family_detail.no_needs_yet')}
            </span>
          ) : (
            <ul className="space-y-1.5">
              {draft.map((it, i) => (
                <li
                  key={i}
                  className="flex items-center gap-2 bg-surface-deep border border-slate-700 rounded-lg px-3 py-1.5"
                >
                  <span className="flex-1 text-sm text-slate-100">{it.name}</span>
                  <input
                    type="number"
                    min={1}
                    value={it.quantity}
                    onChange={(e) => updateDraftQty(i, +e.target.value)}
                    aria-label={`Quantity for ${it.name}`}
                    className="w-16 bg-surface border border-slate-700 rounded px-2 py-1 text-xs text-center"
                  />
                  <button
                    onClick={() => removeDraftItem(i)}
                    aria-label={`Remove ${it.name}`}
                    className="touch-target p-1 hover:bg-red-500/10 hover:text-red-400 rounded"
                  >
                    <X size={12} />
                  </button>
                </li>
              ))}
            </ul>
          )}
          <div className="flex flex-col sm:flex-row gap-1.5">
            <input
              value={draftName}
              onChange={(e) => setDraftName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  addDraftItem();
                }
              }}
              placeholder={t('family_detail.add_need_placeholder') ?? ''}
              className="flex-1 bg-surface-deep border border-slate-700 rounded-lg px-3 py-2 text-sm focus:border-brand outline-none"
            />
            <input
              type="number"
              min={1}
              value={draftQty}
              onChange={(e) => setDraftQty(+e.target.value)}
              aria-label="Quantity"
              className="w-20 bg-surface-deep border border-slate-700 rounded-lg px-3 py-2 text-sm text-center focus:border-brand outline-none"
            />
            <button
              onClick={addDraftItem}
              disabled={!draftName.trim() || !Number.isFinite(draftQty) || draftQty < 1}
              className="touch-target px-3 py-2 bg-surface-light hover:bg-slate-600 disabled:opacity-40 disabled:cursor-not-allowed rounded-lg text-xs flex items-center justify-center gap-1"
            >
              + {t('distribute.add_item')}
            </button>
          </div>
          {qtyError && (
            <div className="text-[11px] text-amber-400 italic" role="alert">
              ⚠ {qtyError}
            </div>
          )}
          {saveError && (
            <div className="text-xs text-priority-critical bg-priority-critical/10 border border-priority-critical/30 rounded-lg px-3 py-2" role="alert">
              {saveError}
            </div>
          )}
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
        <div className="text-xs text-slate-500 italic">
          {t('family_detail.no_needs_yet')}
        </div>
      ) : (
        <div className="flex flex-wrap gap-1.5">
          {items.map((item, i) => (
            <span
              key={i}
              className="text-xs bg-brand/15 text-brand border border-brand/30 px-2 py-0.5 rounded-full"
            >
              {item.name} <span className="opacity-70">×{item.quantity}</span>
            </span>
          ))}
        </div>
      )}
    </Card>
  );
}


// --- Helper presentational components ---------------------------------------

function LastAidIndicator({ lastAidAt }: { lastAidAt?: string }) {
  if (!lastAidAt) {
    return <span className="text-priority-critical">Never received aid</span>;
  }
  const days = Math.floor(
    (Date.now() - new Date(lastAidAt).getTime()) / 86_400_000
  );
  const label =
    days === 0 ? 'today' : days === 1 ? 'yesterday' : `${days} days ago`;
  const colour =
    days <= 3
      ? 'text-priority-normal'
      : days <= 7
      ? 'text-priority-medium'
      : 'text-priority-high';
  return (
    <span className={colour}>
      <CheckCircle2 size={12} className="inline me-1" />
      Last aid {label}
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
    <div className="flex justify-between items-center gap-3">
      <dt className="text-slate-400 flex items-center gap-1.5">
        {icon}
        <span>{label}</span>
      </dt>
      <dd className="font-medium text-slate-100 capitalize">{value}</dd>
    </div>
  );
}
