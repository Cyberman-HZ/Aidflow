// Distribute — full CRUD for distribution orders.
//
// Three tabs:
//   1. Active orders   (pending + out_for_delivery)  — operational queue
//   2. History         (delivered + failed + cancelled)
//   3. New order       (4-step wizard creates a 'pending' or 'out_for_delivery' order)
//
// Status lifecycle:
//     pending → out_for_delivery → delivered
//                              ↘ failed → out_for_delivery (retry)
//                              ↘ cancelled
//
// Family priority is recomputed only when a delivery is confirmed (status →
// 'delivered'), since that's when the family was actually served.

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
  Truck,
  History as HistoryIcon,
  Search,
  Download,
  Flag,
  Calendar,
  XCircle,
  Edit2,
  Trash2,
  Clock,
  RotateCcw,
  Sparkles,
  Users,
  Info,
  Save,
} from 'lucide-react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '@/db/database';
import { Card } from '@/components/Card';
import PriorityBadge from '@/components/PriorityBadge';
import EmptyState from '@/components/EmptyState';
import Loading from '@/components/Loading';
import StatusBadge, { ALLOWED_TRANSITIONS } from '@/components/StatusBadge';
import AIChat from '@/components/AIChat';
import { computeRuleScore, sortByScore } from '@/services/priorityRules';
import { recomputeAfterUpdate } from '@/services/ollama';
import { formatOrderNumber, nextOrderNumber } from '@/services/orderNumber';
import { useAuthStore } from '@/stores/authStore';
import { useSettingsStore } from '@/stores/settingsStore';
import type {
  Family,
  AidDistribution,
  PrioritizationResult,
  Worker,
  DistributionStatus,
} from '@/types';

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

type Tab = 'active' | 'history' | 'new';

// =========================================================================
// Top-level page
// =========================================================================

export default function Distribute() {
  const { t } = useTranslation();
  const [tab, setTab] = useState<Tab>('active');

  // Counts shown on tab labels
  const activeCount = useLiveQuery(
    () =>
      db.distributions
        .where('status')
        .anyOf(['pending', 'out_for_delivery'])
        .count(),
    []
  ) ?? 0;
  const historyCount = useLiveQuery(
    () =>
      db.distributions
        .where('status')
        .anyOf(['delivered', 'failed', 'cancelled'])
        .count(),
    []
  ) ?? 0;

  return (
    <div className="space-y-5">
      <header className="flex items-center justify-between flex-wrap gap-3">
        <h1 className="text-2xl font-bold flex items-center gap-2">
          <PackageCheck size={22} /> {t('distribute.title')}
        </h1>
        {tab !== 'new' && (
          <button
            onClick={() => setTab('new')}
            className="touch-target px-4 py-2 bg-brand hover:bg-brand-dark text-white rounded-lg flex items-center gap-2 font-semibold"
          >
            <Plus size={16} /> {t('distribute.create_order')}
          </button>
        )}
      </header>

      <div className="flex border-b border-slate-700 -mt-1 overflow-x-auto">
        <TabButton
          active={tab === 'active'}
          onClick={() => setTab('active')}
          icon={<Truck size={14} />}
          label={`${t('distribute.tab_active')} (${activeCount})`}
        />
        <TabButton
          active={tab === 'history'}
          onClick={() => setTab('history')}
          icon={<HistoryIcon size={14} />}
          label={`${t('distribute.tab_history')} (${historyCount})`}
        />
        <TabButton
          active={tab === 'new'}
          onClick={() => setTab('new')}
          icon={<Plus size={14} />}
          label={t('distribute.tab_new')}
        />
      </div>

      {tab === 'active' && <ActiveOrders />}
      {tab === 'history' && <DistributionHistory />}
      {tab === 'new' && <DistributionWizard onCreated={() => setTab('active')} />}
    </div>
  );
}

function TabButton({
  active,
  onClick,
  icon,
  label,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
}) {
  return (
    <button
      onClick={onClick}
      className={`px-4 py-2 -mb-px text-sm font-medium flex items-center gap-2 border-b-2 transition-colors whitespace-nowrap ${
        active
          ? 'border-brand text-brand'
          : 'border-transparent text-slate-400 hover:text-slate-200'
      }`}
    >
      {icon}
      {label}
    </button>
  );
}

// =========================================================================
// Active orders tab
// =========================================================================

function ActiveOrders() {
  const { t } = useTranslation();
  const orders = useLiveQuery(
    () =>
      db.distributions
        .where('status')
        .anyOf(['pending', 'out_for_delivery'])
        .toArray(),
    []
  ) ?? [];
  const families = useLiveQuery(() => db.families.toArray()) ?? [];
  const workers = useLiveQuery(() => db.workers.toArray()) ?? [];

  const familyMap = useMemo(() => new Map(families.map((f) => [f.family_id, f])), [families]);
  const workerMap = useMemo(() => new Map(workers.map((w) => [w.id, w])), [workers]);

  const [statusFilter, setStatusFilter] = useState<DistributionStatus | ''>('');
  const [sectorFilter, setSectorFilter] = useState('');
  const [search, setSearch] = useState('');

  // Toast feedback for status transitions (especially priority recompute on delivery)
  const [toast, setToast] = useState<{
    kind: 'success' | 'info' | 'error';
    message: string;
    detail?: string;
  } | null>(null);
  useEffect(() => {
    if (!toast) return;
    const id = setTimeout(() => setToast(null), 7000);
    return () => clearTimeout(id);
  }, [toast]);

  const sectors = useMemo(
    () => Array.from(new Set(families.map((f) => f.location_sector))).sort(),
    [families]
  );

  const filtered = useMemo(() => {
    let list = [...orders];
    if (statusFilter) list = list.filter((o) => o.status === statusFilter);
    if (sectorFilter) {
      list = list.filter((o) => familyMap.get(o.family_id)?.location_sector === sectorFilter);
    }
    if (search.trim()) {
      const q = search.trim().toLowerCase();
      list = list.filter((o) => {
        const fam = familyMap.get(o.family_id);
        return (
          fam?.head_name.toLowerCase().includes(q) ||
          o.family_id.toLowerCase().includes(q) ||
          o.notes?.toLowerCase().includes(q) ||
          o.items_distributed.some((it) => it.item_name.toLowerCase().includes(q))
        );
      });
    }
    // Pending first, then out_for_delivery; within each, newest first
    return list.sort((a, b) => {
      if (a.status !== b.status) return a.status === 'pending' ? -1 : 1;
      return b.created_at.localeCompare(a.created_at);
    });
  }, [orders, statusFilter, sectorFilter, search, familyMap]);

  // Workers currently out_for_delivery on some other order — passed down to
  // OrderCard so its Reassign action rejects re-assigning to a busy worker.
  const busyByUserId = useMemo(() => {
    const map = new Map<string, AidDistribution>();
    for (const o of orders) {
      if (o.status === 'out_for_delivery' && o.assigned_to) {
        map.set(o.assigned_to, o);
      }
    }
    return map;
  }, [orders]);

  return (
    <div className="space-y-4">
      <Card>
        <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
          <div className="relative">
            <Search size={16} className="absolute top-1/2 -translate-y-1/2 start-3 text-slate-500" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t('distribute.filter_search')}
              className="w-full bg-surface-deep border border-slate-700 rounded-lg ps-9 pe-3 py-2 text-sm focus:border-brand outline-none touch-target"
            />
          </div>
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value as DistributionStatus | '')}
            className="bg-surface-deep border border-slate-700 rounded-lg px-3 py-2 text-sm touch-target"
          >
            <option value="">{t('distribute.all_active_statuses')}</option>
            <option value="pending">{t('distribute.status.pending')}</option>
            <option value="out_for_delivery">{t('distribute.status.out_for_delivery')}</option>
          </select>
          <select
            value={sectorFilter}
            onChange={(e) => setSectorFilter(e.target.value)}
            className="bg-surface-deep border border-slate-700 rounded-lg px-3 py-2 text-sm touch-target"
          >
            <option value="">{t('distribute.filter_sector_all')}</option>
            {sectors.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </div>
      </Card>

      {filtered.length === 0 ? (
        <Card>
          <EmptyState
            icon={<Truck size={28} />}
            title={t('distribute.no_active_orders')}
            body={t('distribute.no_active_orders_hint')}
          />
        </Card>
      ) : (
        <div className="space-y-2">
          {filtered.map((o) => (
            <OrderCard
              key={o.distribution_id}
              order={o}
              family={familyMap.get(o.family_id)}
              assignedTo={o.assigned_to ? workerMap.get(o.assigned_to) : undefined}
              workers={workers}
              busyByUserId={busyByUserId}
              onFeedback={setToast}
            />
          ))}
        </div>
      )}

      {/* Toast — bottom-right floating banner */}
      {toast && (
        <div
          role="status"
          aria-live="polite"
          className={`fixed bottom-6 end-6 z-50 max-w-sm rounded-xl shadow-2xl border px-4 py-3 backdrop-blur-sm ${
            toast.kind === 'success'
              ? 'bg-priority-normal/95 border-priority-normal/50 text-white'
              : toast.kind === 'error'
              ? 'bg-priority-critical/95 border-priority-critical/50 text-white'
              : 'bg-surface-light/95 border-slate-600 text-slate-100'
          }`}
        >
          <div className="text-sm font-semibold flex items-center gap-2">
            <CheckCircle2 size={16} /> {toast.message}
          </div>
          {toast.detail && (
            <div className="text-xs opacity-90 mt-1">{toast.detail}</div>
          )}
        </div>
      )}
    </div>
  );
}

type FeedbackToast = { kind: 'success' | 'info' | 'error'; message: string; detail?: string };

// =========================================================================
// Order card with status transition actions
// =========================================================================

function OrderCard({
  order,
  family,
  assignedTo,
  workers,
  busyByUserId,
  onFeedback,
}: {
  order: AidDistribution;
  family?: Family;
  assignedTo?: Worker;
  workers: Worker[];
  busyByUserId: Map<string, AidDistribution>;
  onFeedback?: (t: FeedbackToast) => void;
}) {
  const { t } = useTranslation();
  const language = useSettingsStore((s) => s.language);
  const currentUser = useAuthStore((s) => s.user);
  const [expanded, setExpanded] = useState(false);
  const [busy, setBusy] = useState(false);
  // Mutually-exclusive inline edit form. null = no form open.
  const [editing, setEditing] = useState<'reassign' | 'schedule' | 'edit' | null>(null);
  // Delivery-confirmation modal. Replaces the old browser prompt() flow.
  const [deliveryOpen, setDeliveryOpen] = useState(false);
  // Reason modal for marking an order failed or cancelled (replaces the
  // native window.prompt). null = closed; otherwise tracks which transition
  // is being collected.
  const [reasonModal, setReasonModal] = useState<'failed' | 'cancelled' | null>(null);

  const totalQty = order.items_distributed.reduce((a, b) => a + b.quantity, 0);
  const allowed = ALLOWED_TRANSITIONS[order.status];
  const isPending = order.status === 'pending';
  const isOutForDelivery = order.status === 'out_for_delivery';

  const transition = async (
    next: DistributionStatus,
    deliveryData?: DeliveryConfirmData,
    failureReason?: string
  ) => {
    if (busy || !currentUser) return;
    setBusy(true);
    try {
      const now = new Date().toISOString();
      const patch: Partial<AidDistribution> = { status: next };

      if (next === 'out_for_delivery') {
        patch.dispatched_at = now;
      }

      if (next === 'delivered') {
        patch.delivered_at = now;
        // delivered_by points at a Worker (per v7 migration). Prefer the
        // already-assigned worker; if none, fall back to a worker linked to
        // the currently logged-in user (so admins/field workers who confirm
        // their own deliveries still get attributed correctly).
        const linkedWorker = await db.workers.where('user_id').equals(currentUser.user_id).first();
        patch.delivered_by = order.assigned_to ?? linkedWorker?.id;
        if (deliveryData?.generalNotes) patch.post_update_notes = deliveryData.generalNotes;
        if (deliveryData?.flagNewNeed) patch.new_needs_flagged = true;
      }

      if (next === 'failed' || next === 'cancelled') {
        patch.closed_at = now;
        // Reason comes from the FailReasonModal (no more browser prompt).
        // The caller is responsible for ensuring it's non-empty.
        if (!failureReason || !failureReason.trim()) {
          setBusy(false);
          return;
        }
        patch.failure_reason = failureReason.trim();
      }

      await db.distributions.update(order.distribution_id, patch);

      // Recompute family priority only on actual delivery
      if (next === 'delivered' && family) {
        const oldScore = family.priority_score ?? computeRuleScore(family).priority_score;
        // Build the post-delivery family snapshot. The field worker's
        // "next distribution items" become the new recommended_items so the
        // wizard surfaces them next time. Medical & general notes are stored
        // for future reference and to feed the AI assistant.
        //
        // Important: if the worker EMPTIED the next-items list, persist that
        // (write []) so the family card no longer shows stale chips. Only
        // skip the write when deliveryData itself is missing (no modal
        // interaction at all — shouldn't happen in normal flow).
        const updatedFamily: Family = {
          ...family,
          last_aid_at: now,
          new_need_flagged: !!patch.new_needs_flagged,
          last_updated: now,
          ...(deliveryData
            ? {
                recommended_items: (deliveryData.nextItems ?? [])
                  .map((i) => i.item_name.trim())
                  .filter((s) => s.length > 0),
              }
            : {}),
          ...(deliveryData?.medicalNotes
            ? { last_medical_notes: deliveryData.medicalNotes }
            : {}),
          ...(deliveryData?.generalNotes
            ? { last_delivery_notes: deliveryData.generalNotes }
            : {}),
        };
        const recompute = await recomputeAfterUpdate(
          updatedFamily,
          oldScore,
          `Items delivered: ${order.items_distributed
            .map((i) => `${i.item_name} ×${i.quantity}`)
            .join(', ')}. Notes: ${patch.post_update_notes || '—'}.${
            deliveryData?.medicalNotes ? ` Medical: ${deliveryData.medicalNotes}.` : ''
          }`,
          language
        );
        await db.families.put({
          ...updatedFamily,
          priority_score: recompute.new_score,
          priority_level:
            recompute.new_score >= 80
              ? 'CRITICAL'
              : recompute.new_score >= 60
              ? 'HIGH'
              : recompute.new_score >= 40
              ? 'MEDIUM'
              : 'NORMAL',
          ai_reason: recompute.reason,
        });

        // Feedback toast — show the before/after priority change
        const delta = recompute.new_score - oldScore;
        const sign = delta >= 0 ? '+' : '';
        onFeedback?.({
          kind: 'success',
          message: `Delivered to ${family.head_name}`,
          detail: `Priority recalculated: ${oldScore} → ${recompute.new_score} (${sign}${delta}). ${recompute.reason}`,
        });
      } else if (next === 'out_for_delivery') {
        onFeedback?.({
          kind: 'info',
          message: `Order dispatched`,
          detail: family ? `${family.head_name} (${order.family_id})` : order.family_id,
        });
      } else if (next === 'failed' || next === 'cancelled') {
        onFeedback?.({
          kind: 'error',
          message: next === 'failed' ? 'Delivery marked failed' : 'Order cancelled',
          detail: family
            ? `${family.head_name} — ${patch.failure_reason}`
            : patch.failure_reason,
        });
      }
    } finally {
      setBusy(false);
    }
  };

  const saveAssignment = async (newAssignee: string) => {
    await db.distributions.update(order.distribution_id, {
      assigned_to: newAssignee || undefined,
    });
    setEditing(null);
  };

  const saveSchedule = async (iso: string | null) => {
    await db.distributions.update(order.distribution_id, {
      scheduled_for: iso ?? undefined,
    });
    setEditing(null);
  };

  const saveEdits = async (patch: { items_distributed: AidDistribution['items_distributed']; notes?: string }) => {
    await db.distributions.update(order.distribution_id, patch);
    setEditing(null);
  };

  const onDelete = async () => {
    if (!confirm(t('distribute.delete_confirm') ?? 'Delete this order?')) return;
    await db.distributions.delete(order.distribution_id);
  };

  const ageMin = Math.round((Date.now() - new Date(order.created_at).getTime()) / 60000);
  const ageLabel =
    ageMin < 60 ? `${ageMin} min` : ageMin < 1440 ? `${Math.round(ageMin / 60)}h` : `${Math.round(ageMin / 1440)}d`;

  return (
    <article className="bg-surface border border-slate-700 hover:border-brand/40 rounded-xl p-4 transition-colors">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="flex-1 min-w-0 cursor-pointer" onClick={() => setExpanded(!expanded)}>
          <div className="flex items-center gap-2 flex-wrap">
            <StatusBadge status={order.status} size="sm" />
            <span className="text-xs font-mono font-semibold bg-brand/15 text-brand px-2 py-0.5 rounded">
              {formatOrderNumber(order.order_number)}
            </span>
            {family ? (
              <Link
                to={`/families/${family.family_id}`}
                onClick={(e) => e.stopPropagation()}
                className="font-semibold hover:text-brand transition-colors"
              >
                {family.head_name}
              </Link>
            ) : (
              <span className="font-semibold text-slate-400">Unknown family</span>
            )}
            <span className="text-xs text-slate-500">{order.family_id}</span>
            {order.new_needs_flagged && (
              <span className="text-[10px] px-2 py-0.5 rounded-full bg-priority-critical/20 text-priority-critical font-semibold flex items-center gap-1">
                <Flag size={10} /> NEW NEED
              </span>
            )}
            <PriorityBadge
              level={
                order.ai_priority_score >= 80
                  ? 'CRITICAL'
                  : order.ai_priority_score >= 60
                  ? 'HIGH'
                  : order.ai_priority_score >= 40
                  ? 'MEDIUM'
                  : 'NORMAL'
              }
              score={order.ai_priority_score}
              size="sm"
            />
          </div>
          <div className="text-xs text-slate-400 mt-1 flex flex-wrap gap-x-3 gap-y-0.5">
            <span>
              <Clock size={11} className="inline me-1" />
              {ageLabel} ago
            </span>
            {family?.location_sector && <span>{family.location_sector}</span>}
            <span>
              {assignedTo
                ? `→ ${assignedTo.first_name} ${assignedTo.last_name}`
                : t('distribute.unassigned')}
            </span>
            <span>
              {order.items_distributed.length} item type
              {order.items_distributed.length === 1 ? '' : 's'} · {totalQty} total
            </span>
            {order.scheduled_for && (
              <span>
                <Calendar size={11} className="inline me-1" />
                {new Date(order.scheduled_for).toLocaleDateString()}
              </span>
            )}
          </div>
          <div className="text-xs text-slate-300 mt-1 line-clamp-1">
            {order.items_distributed.map((i) => `${i.item_name} ×${i.quantity}`).join(', ')}
          </div>
        </div>
      </div>

      {/* Inline edit forms (mutually exclusive — only one open at a time) */}
      {editing === 'reassign' && (
        <ReassignPanel
          workers={workers}
          busyByUserId={busyByUserId}
          currentDistributionId={order.distribution_id}
          currentAssignee={order.assigned_to}
          onSave={saveAssignment}
          onClose={() => setEditing(null)}
        />
      )}
      {editing === 'schedule' && (
        <SchedulePanel
          currentScheduledFor={order.scheduled_for}
          onSave={saveSchedule}
          onClose={() => setEditing(null)}
        />
      )}
      {editing === 'edit' && (
        <EditPanel
          order={order}
          onSave={saveEdits}
          onClose={() => setEditing(null)}
        />
      )}

      {/* Action row — hidden while an inline editor is open */}
      {!editing && (
        <div className="mt-3 flex flex-wrap gap-2 items-center">
          {allowed.includes('out_for_delivery') && (
            <button
              onClick={() => void transition('out_for_delivery')}
              disabled={busy || !order.assigned_to}
              title={
                !order.assigned_to
                  ? (t('distribute.dispatch_needs_worker') ?? '')
                  : undefined
              }
              className="touch-target px-3 py-1.5 bg-priority-medium/15 hover:bg-priority-medium/25 text-priority-medium border border-priority-medium/30 rounded-lg text-xs font-semibold flex items-center gap-1 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <Truck size={12} />{' '}
              {order.status === 'failed' ? t('distribute.action.retry') : t('distribute.action.dispatch')}
            </button>
          )}
          {allowed.includes('delivered') && (
            <button
              onClick={() => setDeliveryOpen(true)}
              disabled={busy}
              className="touch-target px-3 py-1.5 bg-priority-normal/15 hover:bg-priority-normal/25 text-priority-normal border border-priority-normal/30 rounded-lg text-xs font-semibold flex items-center gap-1"
            >
              <CheckCircle2 size={12} /> {t('distribute.action.mark_delivered')}
            </button>
          )}
          {allowed.includes('failed') && (
            <button
              onClick={() => setReasonModal('failed')}
              disabled={busy}
              className="touch-target px-3 py-1.5 bg-priority-critical/10 hover:bg-priority-critical/20 text-priority-critical border border-priority-critical/30 rounded-lg text-xs font-semibold flex items-center gap-1"
            >
              <AlertTriangle size={12} /> {t('distribute.action.mark_failed')}
            </button>
          )}
          {allowed.includes('cancelled') && (
            <button
              onClick={() => setReasonModal('cancelled')}
              disabled={busy}
              className="touch-target px-3 py-1.5 bg-surface-light hover:bg-slate-600 text-slate-300 rounded-lg text-xs flex items-center gap-1"
            >
              <XCircle size={12} /> {t('distribute.action.cancel')}
            </button>
          )}

          {/* Pending-only edit affordances */}
          {isPending && (
            <>
              <button
                onClick={() => setEditing('schedule')}
                className="touch-target px-3 py-1.5 bg-surface-light hover:bg-slate-600 text-slate-300 rounded-lg text-xs flex items-center gap-1"
              >
                <Calendar size={12} /> {t('distribute.action.schedule')}
              </button>
              <button
                onClick={() => setEditing('edit')}
                className="touch-target px-3 py-1.5 bg-surface-light hover:bg-slate-600 text-slate-300 rounded-lg text-xs flex items-center gap-1"
              >
                <Edit2 size={12} /> {t('distribute.action.edit')}
              </button>
              <button
                onClick={() => setEditing('reassign')}
                className="touch-target px-3 py-1.5 bg-surface-light hover:bg-slate-600 text-slate-300 rounded-lg text-xs flex items-center gap-1"
              >
                <Users size={12} /> {t('distribute.action.reassign')}
              </button>
            </>
          )}

          {/* Out-for-delivery: reassign deliberately omitted (worker is en route);
              show a disabled hint so supervisors don't look for it. */}
          {isOutForDelivery && (
            <span className="px-3 py-1.5 text-xs text-slate-500 italic flex items-center gap-1">
              <Info size={11} /> {t('distribute.reassign_blocked_in_flight')}
            </span>
          )}

          <button
            onClick={() => void onDelete()}
            className="touch-target px-3 py-1.5 hover:bg-priority-critical/10 hover:text-priority-critical text-slate-500 rounded-lg text-xs flex items-center gap-1 ms-auto"
            aria-label={t('distribute.action.delete')}
          >
            <Trash2 size={12} />
          </button>
        </div>
      )}

      {expanded && (
        <div className="mt-3 pt-3 border-t border-slate-700 space-y-2 text-xs">
          {order.notes && (
            <div>
              <div className="text-slate-400 font-medium mb-0.5">{t('distribute.creator_notes')}</div>
              <div className="text-slate-200 italic">{order.notes}</div>
            </div>
          )}
          {order.ai_reasoning && (
            <div>
              <div className="text-slate-400 font-medium mb-0.5">{t('distribute.ai_reasoning')}</div>
              <div className="text-slate-200 italic">{order.ai_reasoning}</div>
            </div>
          )}
          <div>
            <div className="text-slate-400 font-medium mb-0.5">{t('distribute.items')}</div>
            <ul className="space-y-0.5">
              {order.items_distributed.map((it, i) => (
                <li key={i} className="flex justify-between bg-surface-deep px-2 py-1 rounded">
                  <span>{it.item_name}</span>
                  <span className="text-slate-400">
                    ×{it.quantity} · {it.category}
                  </span>
                </li>
              ))}
            </ul>
          </div>
          <div className="text-slate-500">
            Created {new Date(order.created_at).toLocaleString()}
            {order.dispatched_at && ` · Dispatched ${new Date(order.dispatched_at).toLocaleString()}`}
          </div>
        </div>
      )}

      {deliveryOpen && (
        <DeliveryConfirmModal
          family={family}
          deliveredItems={order.items_distributed}
          onClose={() => setDeliveryOpen(false)}
          onConfirm={async (data) => {
            setDeliveryOpen(false);
            await transition('delivered', data);
          }}
        />
      )}

      {reasonModal && (
        <FailReasonModal
          kind={reasonModal}
          familyName={family?.head_name}
          orderLabel={formatOrderNumber(order.order_number)}
          onClose={() => setReasonModal(null)}
          onConfirm={async (reason) => {
            const k = reasonModal;
            setReasonModal(null);
            if (k) await transition(k, undefined, reason);
          }}
        />
      )}
    </article>
  );
}

// =========================================================================
// New order wizard
// =========================================================================

function DistributionWizard({ onCreated }: { onCreated: () => void }) {
  const { t } = useTranslation();
  const user = useAuthStore((s) => s.user);
  const families = useLiveQuery(() => db.families.toArray()) ?? [];
  const workers = useLiveQuery(() => db.workers.toArray()) ?? [];

  // Workers currently dispatched on a delivery shouldn't be eligible for new
  // orders until they finish (mark delivered/failed/cancelled). We watch the
  // out_for_delivery set live so the dropdown reflects reality.
  const inFlight = useLiveQuery(
    () => db.distributions.where('status').equals('out_for_delivery').toArray(),
    []
  ) ?? [];
  const busyByWorkerId = useMemo(() => {
    const map = new Map<string, AidDistribution>();
    for (const d of inFlight) {
      if (d.assigned_to) map.set(d.assigned_to, d);
    }
    return map;
  }, [inFlight]);

  const [step, setStep] = useState(1);
  const [sector, setSector] = useState('');
  const [selectedFamilyId, setSelectedFamilyId] = useState<string>('');
  const [items, setItems] = useState<LineItem[]>([
    { item_name: 'Family food parcel (15 days)', quantity: 1, category: 'food' },
  ]);
  const [notes, setNotes] = useState('');
  const [assignedTo, setAssignedTo] = useState('');
  const [scheduledFor, setScheduledFor] = useState('');
  const [dispatchNow, setDispatchNow] = useState(false);
  const [saving, setSaving] = useState(false);

  const sectors = useMemo(
    () => Array.from(new Set(families.map((f) => f.location_sector))).sort(),
    [families]
  );

  const sectorFamilies = useMemo(() => {
    const filtered = families.filter((f) => !sector || f.location_sector === sector);
    const ranked: PrioritizationResult[] = sortByScore(filtered.map((f) => computeRuleScore(f)));
    const byId = new Map(ranked.map((r) => [r.family_id, r]));
    return filtered
      .slice()
      .sort(
        (a, b) =>
          byId.get(b.family_id)!.priority_score - byId.get(a.family_id)!.priority_score
      )
      .map((f) => ({ family: f, result: byId.get(f.family_id)! }));
  }, [families, sector]);

  const selectedFamily = families.find((f) => f.family_id === selectedFamilyId);

  const next = () => setStep((s) => Math.min(4, s + 1));
  const back = () => setStep((s) => Math.max(1, s - 1));

  const updateItem = (i: number, patch: Partial<LineItem>) =>
    setItems((arr) => arr.map((it, idx) => (idx === i ? { ...it, ...patch } : it)));
  const addItem = () => setItems((arr) => [...arr, { item_name: '', quantity: 1, category: 'general' }]);
  const removeItem = (i: number) => setItems((arr) => arr.filter((_, idx) => idx !== i));

  const submit = async () => {
    if (!selectedFamily || !user) return;
    // Hard guard: an order cannot be Out for delivery without an assignee.
    // The UI already disables the button in this case but we double-check
    // here to protect against state desync.
    const willDispatch = dispatchNow && !!assignedTo;
    setSaving(true);
    try {
      const now = new Date().toISOString();
      const score =
        selectedFamily.priority_score ?? computeRuleScore(selectedFamily).priority_score;
      const order_number = await nextOrderNumber();
      const order: AidDistribution = {
        distribution_id: `D-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        order_number,
        family_id: selectedFamily.family_id,
        session_id: `S-${now.slice(0, 10)}`,
        status: willDispatch ? 'out_for_delivery' : 'pending',
        items_distributed: items.filter((i) => i.item_name.trim()),
        created_at: now,
        created_by: user.user_id,
        assigned_to: assignedTo || undefined,
        scheduled_for: scheduledFor ? new Date(scheduledFor).toISOString() : undefined,
        dispatched_at: willDispatch ? now : undefined,
        ai_priority_score: score,
        ai_reasoning: selectedFamily.ai_reason ?? '',
        notes: notes.trim() || undefined,
      };
      await db.distributions.add(order);
      onCreated();
    } finally {
      setSaving(false);
    }
  };

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
          <ul className="divide-y divide-slate-700 -my-2 max-h-[60vh] overflow-y-auto">
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
        <Card title={t('distribute.step3_items')}>
          <div className="text-sm bg-surface-light p-3 rounded-lg mb-4">
            <div className="font-medium">{selectedFamily.head_name}</div>
            <div className="text-xs text-slate-400">
              {selectedFamily.family_id} · {selectedFamily.location_sector} ·{' '}
              {selectedFamily.member_count} members
            </div>
            {selectedFamily.recommended_items && selectedFamily.recommended_items.length > 0 && (
              <div className="mt-2 flex flex-wrap items-center gap-1.5">
                <span className="text-[10px] font-semibold text-slate-500 uppercase tracking-wide flex items-center gap-1">
                  <Sparkles size={10} className="text-ai" /> Suggested needs:
                </span>
                {selectedFamily.recommended_items.slice(0, 6).map((it, i) => (
                  <span
                    key={i}
                    className="text-[11px] bg-ai/15 text-ai border border-ai/30 px-2 py-0.5 rounded-full"
                  >
                    {it}
                  </span>
                ))}
              </div>
            )}
          </div>

          <div className="flex items-center justify-between mb-2">
            <h3 className="text-sm font-medium">{t('distribute.items')}</h3>
            <button
              type="button"
              onClick={() => {
                const recommended = computeRuleScore(selectedFamily).recommended_items;
                setItems(
                  recommended.map((name) => {
                    const tmpl =
                      ITEM_TEMPLATES.find((tt) =>
                        tt.name.toLowerCase().includes(name.toLowerCase())
                      ) ??
                      ITEM_TEMPLATES.find((tt) =>
                        name.toLowerCase().includes(tt.name.toLowerCase().split(' ')[0])
                      );
                    return {
                      item_name: tmpl?.name ?? name,
                      quantity: 1,
                      category: tmpl?.category ?? 'general',
                    };
                  })
                );
              }}
              className="text-xs text-ai hover:underline flex items-center gap-1"
            >
              <Sparkles size={12} /> {t('distribute.apply_ai_suggestion')}
            </button>
          </div>
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
                    <option key={tmpl.name} value={tmpl.name}>
                      {tmpl.name}
                    </option>
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

          {/* Compact AI helper — collapsed by default to keep step 3 short */}
          <WizardAIHelper family={selectedFamily} />

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
        <Card title={t('distribute.step4_dispatch')}>
          <div className="space-y-3">
            <div>
              <label className="block text-xs text-slate-400 mb-1.5 font-medium">
                {t('distribute.assigned_to')}
              </label>
              <select
                value={assignedTo}
                onChange={(e) => {
                  // Defensive: don't allow setting a busy worker even if the
                  // dropdown's `disabled` is bypassed (e.g. via DevTools).
                  const v = e.target.value;
                  if (v && busyByWorkerId.has(v)) return;
                  setAssignedTo(v);
                }}
                className="w-full bg-surface-deep border border-slate-700 rounded-lg px-3 py-2 text-sm focus:border-brand outline-none"
              >
                <option value="">{t('distribute.unassigned')}</option>
                {workers.map((w) => {
                  const busy = busyByWorkerId.get(w.id);
                  return (
                    <option key={w.id} value={w.id} disabled={!!busy}>
                      {w.first_name} {w.last_name} ({w.position})
                      {busy ? ` — ${t('distribute.busy_label')}` : ''}
                    </option>
                  );
                })}
              </select>
              {busyByWorkerId.size > 0 && (
                <p className="text-[11px] text-slate-500 mt-1.5 italic">
                  {t('distribute.busy_hint', { count: busyByWorkerId.size })}
                </p>
              )}
            </div>

            <div>
              <label className="block text-xs text-slate-400 mb-1.5 font-medium">
                {t('distribute.scheduled_for')}
              </label>
              <input
                type="datetime-local"
                value={scheduledFor}
                onChange={(e) => setScheduledFor(e.target.value)}
                className="w-full bg-surface-deep border border-slate-700 rounded-lg px-3 py-2 text-sm focus:border-brand outline-none"
              />
            </div>

            <div>
              <label className="block text-xs text-slate-400 mb-1.5 font-medium">
                {t('distribute.creator_notes')}
              </label>
              <textarea
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                rows={2}
                className="w-full bg-surface-deep border border-slate-700 rounded-lg px-3 py-2 text-sm focus:border-brand outline-none"
                placeholder="e.g. Critical case — escort by medical lead."
              />
            </div>

            {/* "Dispatch immediately" is only valid with an assignee — an
                order can't be Out for delivery if no one is delivering it. */}
            <label
              className={`flex items-center gap-2 text-sm ${
                assignedTo ? 'cursor-pointer' : 'cursor-not-allowed opacity-60'
              }`}
            >
              <input
                type="checkbox"
                checked={dispatchNow && !!assignedTo}
                disabled={!assignedTo}
                onChange={(e) => setDispatchNow(e.target.checked)}
                className="accent-priority-medium"
              />
              <Truck size={14} className="text-priority-medium" />
              <span>{t('distribute.dispatch_immediately')}</span>
            </label>
            {!assignedTo && (
              <p className="text-[11px] text-slate-500 italic mt-1">
                {t('distribute.dispatch_needs_worker')}
              </p>
            )}
          </div>

          <div className="flex justify-between mt-5">
            <button onClick={back} className="touch-target px-4 py-2 bg-surface-light rounded-lg flex items-center gap-1">
              <ChevronLeft size={16} /> {t('distribute.back')}
            </button>
            <button
              onClick={() => void submit()}
              disabled={saving || (dispatchNow && !assignedTo)}
              title={
                dispatchNow && !assignedTo
                  ? (t('distribute.dispatch_needs_worker') ?? '')
                  : undefined
              }
              className="touch-target px-4 py-2 bg-brand hover:bg-brand-dark disabled:opacity-60 rounded-lg flex items-center gap-2 font-semibold"
            >
              {saving ? <Loading /> : <CheckCircle2 size={16} />}
              {t('distribute.create_order')}
            </button>
          </div>
        </Card>
      )}
    </div>
  );
}

// Compact, collapsible AI helper rendered inside wizard step 3.
// Fixed height (no flex sizing, so it can never collapse the page).
function WizardAIHelper({ family }: { family: Family }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);

  const systemPrompt =
    `You are AidFlow Pro's distribution-planning assistant powered by Gemma 4. ` +
    `A field worker is preparing an aid distribution order for the family below. ` +
    `Recommend specific aid items and quantities tailored to this family's demographics, medical conditions, displacement, and time since last aid. ` +
    `Be concrete and concise — bulleted list with item name + quantity + 1-line rationale. ` +
    `Catalogue: ${ITEM_TEMPLATES.map((it) => it.name).join('; ')}.\n\n` +
    `## FAMILY UNDER REVIEW\n` +
    JSON.stringify(
      {
        family_id: family.family_id,
        head_name: family.head_name,
        sector: family.location_sector,
        member_count: family.member_count,
        children_under_5: family.children_under_5,
        elderly_count: family.elderly_count,
        has_pregnant_member: family.has_pregnant_member,
        medical_conditions: family.medical_conditions,
        displacement_status: family.displacement_status,
        income_level: family.income_level,
        last_aid_days_ago: family.last_aid_at
          ? Math.floor((Date.now() - new Date(family.last_aid_at).getTime()) / 86_400_000)
          : 'never',
        priority_score: family.priority_score,
        notes: family.notes,
      },
      null,
      2
    );

  return (
    <div className="mt-5 border-t border-slate-700 pt-4">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex items-center gap-2 text-sm font-medium text-ai hover:text-violet-400"
      >
        <Sparkles size={14} />
        {t('distribute.ai_helper_title')}
        <ChevronRight
          size={14}
          className={`transition-transform ${open ? 'rotate-90' : ''}`}
        />
      </button>
      {open && (
        <div className="mt-3">
          {/* AIChat with flex={false} self-caps via max-h-[60vh] on the messages area */}
          <AIChat
            flex={false}
            enableRag={false}
            enableWiki={false}
            contextLabel={`${family.head_name} · ${family.family_id}`}
            placeholder={t('distribute.ai_helper_placeholder')}
            systemPrompt={systemPrompt}
          />
        </div>
      )}
    </div>
  );
}

// =========================================================================
// Inline order edit panels
// =========================================================================

function ReassignPanel({
  workers,
  busyByUserId,
  currentDistributionId,
  currentAssignee,
  onSave,
  onClose,
}: {
  workers: Worker[];
  busyByUserId: Map<string, AidDistribution>;
  currentDistributionId: string;
  currentAssignee?: string;
  onSave: (id: string) => Promise<void>;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [picked, setPicked] = useState<string>(currentAssignee ?? '');

  // Available = workers who aren't busy on a different order.
  // The current assignee remains selectable so the supervisor can keep them.
  const isAvailable = (w: Worker) => {
    const b = busyByUserId.get(w.id);
    return !b || b.distribution_id === currentDistributionId;
  };
  const available = workers.filter(isAvailable);

  return (
    <div className="mt-3 bg-surface-light border border-brand/30 rounded-lg p-3 space-y-2">
      <div className="text-xs font-semibold text-brand flex items-center gap-1.5">
        <Users size={12} /> {t('distribute.reassign_to')}
      </div>
      {available.length === 0 ? (
        <div className="text-xs text-priority-medium italic">
          {t('distribute.no_available_workers')}
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5">
          <label
            className={`flex items-center gap-2 px-2 py-1.5 rounded cursor-pointer text-sm ${
              picked === '' ? 'bg-brand/15 ring-1 ring-brand/40' : 'hover:bg-surface-deep'
            }`}
          >
            <input
              type="radio"
              checked={picked === ''}
              onChange={() => setPicked('')}
              className="accent-brand"
            />
            <span className="text-slate-400 italic">{t('distribute.unassigned')}</span>
          </label>
          {available.map((w) => (
            <label
              key={w.id}
              className={`flex items-center gap-2 px-2 py-1.5 rounded cursor-pointer text-sm ${
                picked === w.id ? 'bg-brand/15 ring-1 ring-brand/40' : 'hover:bg-surface-deep'
              }`}
            >
              <input
                type="radio"
                checked={picked === w.id}
                onChange={() => setPicked(w.id)}
                className="accent-brand"
              />
              <span className="font-medium">
                {w.first_name} {w.last_name}
              </span>
              <span className="text-xs text-slate-500">({w.position})</span>
              {currentAssignee === w.id && (
                <span className="text-[10px] text-brand ms-auto">current</span>
              )}
            </label>
          ))}
        </div>
      )}
      <div className="flex gap-2 pt-2">
        <button
          onClick={() => void onSave(picked)}
          className="touch-target px-3 py-1.5 bg-brand hover:bg-brand-dark text-white rounded text-xs font-semibold flex items-center gap-1"
        >
          <Save size={12} /> {t('distribute.save')}
        </button>
        <button
          onClick={onClose}
          className="touch-target px-3 py-1.5 bg-surface-deep hover:bg-slate-700 text-slate-300 rounded text-xs flex items-center gap-1"
        >
          <X size={12} /> {t('common.cancel')}
        </button>
      </div>
    </div>
  );
}

function SchedulePanel({
  currentScheduledFor,
  onSave,
  onClose,
}: {
  currentScheduledFor?: string;
  onSave: (iso: string | null) => Promise<void>;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  // <input type="datetime-local"> wants format "YYYY-MM-DDTHH:mm" without timezone.
  const toLocalInput = (iso?: string) => {
    if (!iso) return '';
    const d = new Date(iso);
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(
      d.getHours()
    )}:${pad(d.getMinutes())}`;
  };
  const [value, setValue] = useState(toLocalInput(currentScheduledFor));

  const handleSave = () => {
    if (!value) {
      void onSave(null); // clear schedule
      return;
    }
    const d = new Date(value);
    if (isNaN(d.getTime())) return;
    void onSave(d.toISOString());
  };

  return (
    <div className="mt-3 bg-surface-light border border-brand/30 rounded-lg p-3 space-y-2">
      <div className="text-xs font-semibold text-brand flex items-center gap-1.5">
        <Calendar size={12} /> {t('distribute.schedule_for')}
      </div>
      <input
        type="datetime-local"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        className="w-full bg-surface-deep border border-slate-700 rounded-lg px-3 py-2 text-sm focus:border-brand outline-none"
      />
      <p className="text-[11px] text-slate-500">{t('distribute.schedule_hint')}</p>
      <div className="flex gap-2 pt-1">
        <button
          onClick={handleSave}
          className="touch-target px-3 py-1.5 bg-brand hover:bg-brand-dark text-white rounded text-xs font-semibold flex items-center gap-1"
        >
          <Save size={12} /> {t('distribute.save')}
        </button>
        {currentScheduledFor && (
          <button
            onClick={() => void onSave(null)}
            className="touch-target px-3 py-1.5 bg-surface-deep hover:bg-slate-700 text-slate-300 rounded text-xs flex items-center gap-1"
          >
            <X size={12} /> {t('distribute.clear_schedule')}
          </button>
        )}
        <button
          onClick={onClose}
          className="touch-target px-3 py-1.5 bg-surface-deep hover:bg-slate-700 text-slate-300 rounded text-xs flex items-center gap-1 ms-auto"
        >
          {t('common.cancel')}
        </button>
      </div>
    </div>
  );
}

function EditPanel({
  order,
  onSave,
  onClose,
}: {
  order: AidDistribution;
  onSave: (patch: { items_distributed: AidDistribution['items_distributed']; notes?: string }) => Promise<void>;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [items, setItems] = useState<LineItem[]>(
    order.items_distributed.map((i) => ({ ...i }))
  );
  const [notes, setNotes] = useState(order.notes ?? '');

  const updateItem = (i: number, patch: Partial<LineItem>) =>
    setItems((arr) => arr.map((it, idx) => (idx === i ? { ...it, ...patch } : it)));
  const addItem = () =>
    setItems((arr) => [...arr, { item_name: '', quantity: 1, category: 'general' }]);
  const removeItem = (i: number) => setItems((arr) => arr.filter((_, idx) => idx !== i));

  const handleSave = () => {
    const cleaned = items.filter((i) => i.item_name.trim());
    if (cleaned.length === 0) {
      alert(t('distribute.edit_at_least_one_item'));
      return;
    }
    void onSave({ items_distributed: cleaned, notes: notes.trim() || undefined });
  };

  return (
    <div className="mt-3 bg-surface-light border border-brand/30 rounded-lg p-3 space-y-3">
      <div className="text-xs font-semibold text-brand flex items-center gap-1.5">
        <Edit2 size={12} /> {t('distribute.edit_order')}
      </div>
      <div>
        <label className="block text-[11px] text-slate-400 mb-1.5 font-medium">
          {t('distribute.items')}
        </label>
        <div className="space-y-1.5">
          {items.map((it, i) => (
            <div key={i} className="flex gap-1.5 items-center">
              <select
                value={it.item_name}
                onChange={(e) => {
                  const tmpl = ITEM_TEMPLATES.find((tt) => tt.name === e.target.value);
                  updateItem(i, {
                    item_name: e.target.value,
                    category: tmpl?.category ?? it.category,
                  });
                }}
                className="flex-1 bg-surface-deep border border-slate-700 rounded px-2 py-1.5 text-xs"
              >
                <option value="">— {t('distribute.add_item')} —</option>
                {ITEM_TEMPLATES.map((tmpl) => (
                  <option key={tmpl.name} value={tmpl.name}>
                    {tmpl.name}
                  </option>
                ))}
                {/* Preserve any custom item that's not in the template list */}
                {it.item_name && !ITEM_TEMPLATES.some((tt) => tt.name === it.item_name) && (
                  <option value={it.item_name}>{it.item_name}</option>
                )}
              </select>
              <input
                type="number"
                min={1}
                value={it.quantity}
                onChange={(e) => updateItem(i, { quantity: Math.max(1, +e.target.value) })}
                className="w-16 bg-surface-deep border border-slate-700 rounded px-2 py-1.5 text-xs text-center"
              />
              <button
                onClick={() => removeItem(i)}
                className="p-1 hover:bg-red-500/10 hover:text-red-400 rounded"
                aria-label="Remove item"
              >
                <X size={12} />
              </button>
            </div>
          ))}
          <button
            onClick={addItem}
            className="text-xs text-brand hover:underline flex items-center gap-1"
          >
            <Plus size={12} /> {t('distribute.add_item')}
          </button>
        </div>
      </div>
      <div>
        <label className="block text-[11px] text-slate-400 mb-1.5 font-medium">
          {t('distribute.creator_notes')}
        </label>
        <textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          rows={2}
          className="w-full bg-surface-deep border border-slate-700 rounded px-2 py-1.5 text-xs"
          placeholder="e.g. Handle with care; ask for the eldest daughter."
        />
      </div>
      <div className="flex gap-2">
        <button
          onClick={handleSave}
          className="touch-target px-3 py-1.5 bg-brand hover:bg-brand-dark text-white rounded text-xs font-semibold flex items-center gap-1"
        >
          <Save size={12} /> {t('distribute.save')}
        </button>
        <button
          onClick={onClose}
          className="touch-target px-3 py-1.5 bg-surface-deep hover:bg-slate-700 text-slate-300 rounded text-xs flex items-center gap-1 ms-auto"
        >
          <X size={12} /> {t('common.cancel')}
        </button>
      </div>
    </div>
  );
}

// =========================================================================
// Delivery confirmation modal
// =========================================================================
//
// Shown when the field worker clicks "Mark delivered". Replaces the old
// browser prompt() / confirm() flow with a structured form so the worker can
// capture three useful pieces of information in one place:
//
//   1. Next distribution items — the family's most pressing needs for the
//      NEXT visit. Saved to family.recommended_items so the wizard surfaces
//      them as "Suggested needs" the next time anyone opens an order for
//      this family.
//   2. Medical notes — saved to family.last_medical_notes (free text).
//   3. General notes — saved to distribution.post_update_notes AND mirrored
//      to family.last_delivery_notes for quick reference.
//
// Plus a "Flag a new urgent need" checkbox that marks the order so it's
// visible on the family card.

export interface DeliveryConfirmData {
  nextItems: { item_name: string; quantity: number; category: string }[];
  medicalNotes: string;
  generalNotes: string;
  flagNewNeed: boolean;
}

function DeliveryConfirmModal({
  family,
  deliveredItems,
  onConfirm,
  onClose,
}: {
  family?: Family;
  deliveredItems: { item_name: string; quantity: number; category: string }[];
  onConfirm: (data: DeliveryConfirmData) => Promise<void> | void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  // Pre-populate "next items" with whatever the family currently has cached
  // as recommended_items (or the most recent items just delivered as a sane
  // default). The worker can edit / clear / add.
  const initial: LineItem[] =
    (family?.recommended_items?.length
      ? family.recommended_items.map((name) => {
          const tmpl = ITEM_TEMPLATES.find(
            (tt) => tt.name.toLowerCase() === name.toLowerCase()
          );
          return {
            item_name: tmpl?.name ?? name,
            quantity: 1,
            category: tmpl?.category ?? 'general',
          };
        })
      : deliveredItems.map((i) => ({ ...i }))) ?? [];

  const [items, setItems] = useState<LineItem[]>(initial);
  const [medicalNotes, setMedicalNotes] = useState(family?.last_medical_notes ?? '');
  const [generalNotes, setGeneralNotes] = useState('');
  const [flagNewNeed, setFlagNewNeed] = useState(false);
  const [saving, setSaving] = useState(false);

  const updateItem = (i: number, patch: Partial<LineItem>) =>
    setItems((arr) => arr.map((it, idx) => (idx === i ? { ...it, ...patch } : it)));
  const addItem = () =>
    setItems((arr) => [...arr, { item_name: '', quantity: 1, category: 'general' }]);
  const removeItem = (i: number) => setItems((arr) => arr.filter((_, idx) => idx !== i));

  const handleConfirm = async () => {
    if (saving) return;
    setSaving(true);
    try {
      await onConfirm({
        nextItems: items.filter((i) => i.item_name.trim().length > 0),
        medicalNotes: medicalNotes.trim(),
        generalNotes: generalNotes.trim(),
        flagNewNeed,
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="delivery-confirm-title"
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-2xl bg-surface border border-priority-normal/40 rounded-xl shadow-2xl flex flex-col max-h-[90vh]"
      >
        <header className="px-5 py-3 border-b border-slate-700 flex items-start justify-between gap-3">
          <div>
            <h2
              id="delivery-confirm-title"
              className="text-base font-bold flex items-center gap-2 text-priority-normal"
            >
              <CheckCircle2 size={18} /> {t('distribute.delivery_confirm.title')}
            </h2>
            {family && (
              <p className="text-xs text-slate-400 mt-0.5">
                {family.head_name} · {family.family_id} · {family.location_sector}
              </p>
            )}
          </div>
          <button
            onClick={onClose}
            className="touch-target p-1.5 hover:bg-surface-light rounded-lg text-slate-400 hover:text-white"
            aria-label={t('common.close')}
          >
            <X size={16} />
          </button>
        </header>

        <div className="px-5 py-4 space-y-5 overflow-y-auto">
          {/* Next distribution items */}
          <section>
            <label className="block text-sm font-semibold mb-1.5 flex items-center gap-1.5">
              <Sparkles size={13} className="text-ai" />
              {t('distribute.delivery_confirm.next_items_title')}
            </label>
            <p className="text-xs text-slate-400 mb-2">
              {t('distribute.delivery_confirm.next_items_hint')}
            </p>
            <div className="space-y-1.5">
              {items.map((it, i) => (
                <div key={i} className="flex gap-1.5 items-center">
                  <select
                    value={it.item_name}
                    onChange={(e) => {
                      const tmpl = ITEM_TEMPLATES.find((tt) => tt.name === e.target.value);
                      updateItem(i, {
                        item_name: e.target.value,
                        category: tmpl?.category ?? it.category,
                      });
                    }}
                    className="flex-1 bg-surface-deep border border-slate-700 rounded px-2 py-2 text-sm"
                  >
                    <option value="">— {t('distribute.add_item')} —</option>
                    {ITEM_TEMPLATES.map((tmpl) => (
                      <option key={tmpl.name} value={tmpl.name}>
                        {tmpl.name}
                      </option>
                    ))}
                    {it.item_name &&
                      !ITEM_TEMPLATES.some((tt) => tt.name === it.item_name) && (
                        <option value={it.item_name}>{it.item_name}</option>
                      )}
                  </select>
                  <input
                    type="number"
                    min={1}
                    value={it.quantity}
                    onChange={(e) =>
                      updateItem(i, { quantity: Math.max(1, +e.target.value) })
                    }
                    className="w-16 bg-surface-deep border border-slate-700 rounded px-2 py-2 text-sm text-center"
                    aria-label="Quantity"
                  />
                  <button
                    onClick={() => removeItem(i)}
                    className="touch-target p-2 hover:bg-red-500/10 hover:text-red-400 rounded"
                    aria-label="Remove item"
                  >
                    <X size={14} />
                  </button>
                </div>
              ))}
              <button
                onClick={addItem}
                className="text-xs text-brand hover:underline flex items-center gap-1 mt-1"
              >
                <Plus size={12} /> {t('distribute.add_item')}
              </button>
            </div>
          </section>

          {/* Medical notes */}
          <section>
            <label
              htmlFor="delivery-medical-notes"
              className="block text-sm font-semibold mb-1.5 flex items-center gap-1.5"
            >
              <AlertTriangle size={13} className="text-priority-critical" />
              {t('distribute.delivery_confirm.medical_notes_title')}
            </label>
            <p className="text-xs text-slate-400 mb-2">
              {t('distribute.delivery_confirm.medical_notes_hint')}
            </p>
            <textarea
              id="delivery-medical-notes"
              value={medicalNotes}
              onChange={(e) => setMedicalNotes(e.target.value)}
              rows={3}
              placeholder={
                t('distribute.delivery_confirm.medical_notes_placeholder') ?? ''
              }
              className="w-full bg-surface-deep border border-slate-700 rounded-lg px-3 py-2 text-sm focus:border-brand outline-none"
            />
          </section>

          {/* General notes */}
          <section>
            <label
              htmlFor="delivery-general-notes"
              className="block text-sm font-semibold mb-1.5 flex items-center gap-1.5"
            >
              <Info size={13} className="text-brand" />
              {t('distribute.delivery_confirm.general_notes_title')}
            </label>
            <p className="text-xs text-slate-400 mb-2">
              {t('distribute.delivery_confirm.general_notes_hint')}
            </p>
            <textarea
              id="delivery-general-notes"
              value={generalNotes}
              onChange={(e) => setGeneralNotes(e.target.value)}
              rows={3}
              placeholder={
                t('distribute.delivery_confirm.general_notes_placeholder') ?? ''
              }
              className="w-full bg-surface-deep border border-slate-700 rounded-lg px-3 py-2 text-sm focus:border-brand outline-none"
            />
          </section>

          {/* New urgent need flag */}
          <label className="flex items-start gap-2 text-sm cursor-pointer bg-surface-light/50 border border-slate-700 rounded-lg px-3 py-2 hover:border-priority-critical/40 transition-colors">
            <input
              type="checkbox"
              checked={flagNewNeed}
              onChange={(e) => setFlagNewNeed(e.target.checked)}
              className="mt-0.5 accent-priority-critical"
            />
            <div>
              <div className="font-medium flex items-center gap-1.5">
                <Flag size={12} className="text-priority-critical" />
                {t('distribute.delivery_confirm.flag_new_need_title')}
              </div>
              <div className="text-xs text-slate-400 mt-0.5">
                {t('distribute.delivery_confirm.flag_new_need_hint')}
              </div>
            </div>
          </label>
        </div>

        <footer className="px-5 py-3 border-t border-slate-700 flex justify-end gap-2 bg-surface-deep/50">
          <button
            onClick={onClose}
            disabled={saving}
            className="touch-target px-4 py-2 bg-surface-light hover:bg-slate-600 disabled:opacity-50 rounded-lg text-sm flex items-center gap-1"
          >
            <X size={14} /> {t('common.cancel')}
          </button>
          <button
            onClick={() => void handleConfirm()}
            disabled={saving}
            className="touch-target px-4 py-2 bg-priority-normal hover:bg-priority-normal/90 disabled:opacity-50 text-white rounded-lg text-sm font-semibold flex items-center gap-1"
          >
            {saving ? <Loading /> : <CheckCircle2 size={14} />}{' '}
            {t('distribute.delivery_confirm.confirm')}
          </button>
        </footer>
      </div>
    </div>
  );
}

// =========================================================================
// Fail / cancel reason modal
// =========================================================================
//
// Replaces the native browser prompt() that used to capture the reason when
// marking an order failed or cancelled. Same UX as the delivery confirmation
// modal: a centered overlay with a textarea + Confirm / Cancel buttons.
//
// "kind" controls the heading and required-vs-optional copy: a failed
// delivery requires a reason (we need to know why for follow-up); cancelling
// also requires a reason since it's a terminal status.

function FailReasonModal({
  kind,
  familyName,
  orderLabel,
  onConfirm,
  onClose,
}: {
  kind: 'failed' | 'cancelled';
  familyName?: string;
  orderLabel: string;
  onConfirm: (reason: string) => void | Promise<void>;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [reason, setReason] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const isFailed = kind === 'failed';

  const handleConfirm = async () => {
    if (submitting) return;
    if (!reason.trim()) return; // button is disabled too — defensive
    setSubmitting(true);
    try {
      await onConfirm(reason.trim());
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="fail-reason-title"
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className={`w-full max-w-md bg-surface border rounded-xl shadow-2xl flex flex-col ${
          isFailed ? 'border-priority-critical/40' : 'border-slate-700'
        }`}
      >
        <header className="px-5 py-3 border-b border-slate-700 flex items-start justify-between gap-3">
          <div>
            <h2
              id="fail-reason-title"
              className={`text-base font-bold flex items-center gap-2 ${
                isFailed ? 'text-priority-critical' : 'text-slate-200'
              }`}
            >
              {isFailed ? <AlertTriangle size={18} /> : <XCircle size={18} />}
              {isFailed
                ? t('distribute.fail_modal_title')
                : t('distribute.cancel_modal_title')}
            </h2>
            <p className="text-xs text-slate-400 mt-0.5">
              {orderLabel}
              {familyName ? ` · ${familyName}` : ''}
            </p>
          </div>
          <button
            onClick={onClose}
            className="touch-target p-1.5 hover:bg-surface-light rounded-lg text-slate-400 hover:text-white"
            aria-label={t('common.close')}
          >
            <X size={16} />
          </button>
        </header>

        <div className="px-5 py-4 space-y-2">
          <label
            htmlFor="fail-reason-textarea"
            className="block text-xs text-slate-400 font-medium"
          >
            {isFailed
              ? t('distribute.fail_reason_prompt')
              : t('distribute.cancel_reason_prompt')}
            <span className="text-priority-critical"> *</span>
          </label>
          <p className="text-[11px] text-slate-500">
            {isFailed
              ? t('distribute.fail_modal_hint')
              : t('distribute.cancel_modal_hint')}
          </p>
          <textarea
            id="fail-reason-textarea"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={4}
            autoFocus
            placeholder={
              isFailed
                ? (t('distribute.fail_modal_placeholder') ?? '')
                : (t('distribute.cancel_modal_placeholder') ?? '')
            }
            className="w-full bg-surface-deep border border-slate-700 rounded-lg px-3 py-2 text-sm focus:border-brand outline-none"
          />
        </div>

        <footer className="px-5 py-3 border-t border-slate-700 flex justify-end gap-2 bg-surface-deep/50">
          <button
            onClick={onClose}
            disabled={submitting}
            className="touch-target px-4 py-2 bg-surface-light hover:bg-slate-600 disabled:opacity-50 rounded-lg text-sm flex items-center gap-1"
          >
            <X size={14} /> {t('common.cancel')}
          </button>
          <button
            onClick={() => void handleConfirm()}
            disabled={submitting || !reason.trim()}
            className={`touch-target px-4 py-2 disabled:opacity-50 text-white rounded-lg text-sm font-semibold flex items-center gap-1 ${
              isFailed
                ? 'bg-priority-critical hover:bg-red-600'
                : 'bg-slate-600 hover:bg-slate-500'
            }`}
          >
            {submitting ? <Loading /> : isFailed ? <AlertTriangle size={14} /> : <XCircle size={14} />}
            {isFailed
              ? t('distribute.action.mark_failed')
              : t('distribute.fail_modal_confirm_cancel')}
          </button>
        </footer>
      </div>
    </div>
  );
}

function Stepper({ step }: { step: number }) {
  const { t } = useTranslation();
  const labels = [
    t('distribute.step1'),
    t('distribute.step2'),
    t('distribute.step3_items'),
    t('distribute.step4_dispatch'),
  ];
  return (
    <ol className="flex flex-wrap items-center gap-2 text-xs">
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
// History tab (delivered + failed + cancelled)
// =========================================================================

function DistributionHistory() {
  const { t } = useTranslation();
  const orders = useLiveQuery(
    () =>
      db.distributions
        .where('status')
        .anyOf(['delivered', 'failed', 'cancelled'])
        .toArray(),
    []
  ) ?? [];
  const families = useLiveQuery(() => db.families.toArray()) ?? [];
  const workers = useLiveQuery(() => db.workers.toArray()) ?? [];

  const [sector, setSector] = useState('');
  const [worker, setWorker] = useState('');
  const [statusFilter, setStatusFilter] = useState<DistributionStatus | ''>('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [search, setSearch] = useState('');

  const sectors = useMemo(
    () => Array.from(new Set(families.map((f) => f.location_sector))).sort(),
    [families]
  );

  const familyMap = useMemo(() => new Map(families.map((f) => [f.family_id, f])), [families]);
  const workerMap = useMemo(() => new Map(workers.map((w) => [w.id, w])), [workers]);

  const filtered = useMemo(() => {
    let list = [...orders];
    if (sector) list = list.filter((d) => familyMap.get(d.family_id)?.location_sector === sector);
    if (worker) {
      list = list.filter(
        (d) => d.delivered_by === worker || d.assigned_to === worker || d.distributed_by === worker
      );
    }
    if (statusFilter) list = list.filter((d) => d.status === statusFilter);
    if (from) {
      list = list.filter((d) => (d.delivered_at || d.created_at).slice(0, 10) >= from);
    }
    if (to) {
      list = list.filter((d) => (d.delivered_at || d.created_at).slice(0, 10) <= to);
    }
    if (search.trim()) {
      const q = search.trim().toLowerCase();
      list = list.filter((d) => {
        const fam = familyMap.get(d.family_id);
        return (
          fam?.head_name.toLowerCase().includes(q) ||
          d.family_id.toLowerCase().includes(q) ||
          d.post_update_notes?.toLowerCase().includes(q) ||
          d.failure_reason?.toLowerCase().includes(q) ||
          d.items_distributed.some((it) => it.item_name.toLowerCase().includes(q))
        );
      });
    }
    return list.sort((a, b) =>
      (b.delivered_at || b.created_at).localeCompare(a.delivered_at || a.created_at)
    );
  }, [orders, familyMap, sector, worker, statusFilter, from, to, search]);

  const totalItems = filtered.reduce(
    (s, d) => s + d.items_distributed.reduce((a, b) => a + b.quantity, 0),
    0
  );
  const uniqueFamilies = new Set(filtered.map((d) => d.family_id)).size;

  const clearFilters = () => {
    setSector('');
    setWorker('');
    setStatusFilter('');
    setFrom('');
    setTo('');
    setSearch('');
  };

  const exportCSV = () => {
    const headers = [
      'order_number', 'distribution_id', 'family_id', 'family_name', 'sector', 'status',
      'created_at', 'delivered_at', 'delivered_by', 'delivered_by_name',
      'items', 'priority_score', 'flagged', 'notes', 'failure_reason',
    ];
    const rows = filtered.map((d) => {
      const fam = familyMap.get(d.family_id);
      const w = d.delivered_by ? workerMap.get(d.delivered_by) : undefined;
      return [
        formatOrderNumber(d.order_number),
        d.distribution_id, d.family_id, fam?.head_name ?? '', fam?.location_sector ?? '',
        d.status, d.created_at, d.delivered_at ?? '',
        d.delivered_by ?? '', w ? `${w.first_name} ${w.last_name}` : '',
        d.items_distributed.map((i) => `${i.item_name} x${i.quantity}`).join('; '),
        d.ai_priority_score, d.new_needs_flagged ? 'yes' : '',
        d.post_update_notes ?? '', d.failure_reason ?? '',
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

  const hasActive =
    sector || worker || statusFilter || from || to || search.trim();

  return (
    <div className="space-y-4">
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
                <option key={s} value={s}>{s}</option>
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
              {workers.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.first_name} {w.last_name} ({w.position})
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-xs text-slate-400 mb-1 font-medium">Status</label>
            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value as DistributionStatus | '')}
              className="w-full bg-surface-deep border border-slate-700 rounded-lg px-3 py-2 text-sm focus:border-brand outline-none"
            >
              <option value="">All</option>
              <option value="delivered">{t('distribute.status.delivered')}</option>
              <option value="failed">{t('distribute.status.failed')}</option>
              <option value="cancelled">{t('distribute.status.cancelled')}</option>
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
            {hasActive && (
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

      {filtered.length === 0 ? (
        <Card>
          <EmptyState icon={<HistoryIcon size={28} />} title={t('distribute.history_empty')} />
        </Card>
      ) : (
        <div className="space-y-2">
          {filtered.map((d) => (
            <HistoryRow
              key={d.distribution_id}
              distribution={d}
              family={familyMap.get(d.family_id)}
              worker={
                d.delivered_by
                  ? workerMap.get(d.delivered_by)
                  : d.assigned_to
                  ? workerMap.get(d.assigned_to)
                  : undefined
              }
              onRetry={async () => {
                if (d.status !== 'failed') return;
                if (!confirm('Retry — set this order back to Out for delivery?')) return;
                await db.distributions.update(d.distribution_id, {
                  status: 'out_for_delivery',
                  dispatched_at: new Date().toISOString(),
                  closed_at: undefined,
                  failure_reason: undefined,
                });
              }}
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
  onRetry,
}: {
  distribution: AidDistribution;
  family?: Family;
  worker?: Worker;
  onRetry: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const totalQty = distribution.items_distributed.reduce((a, b) => a + b.quantity, 0);
  const when = distribution.delivered_at || distribution.closed_at || distribution.created_at;

  return (
    <article
      className="bg-surface border border-slate-700 hover:border-brand/40 rounded-xl p-4 transition-colors"
    >
      <div className="flex items-start justify-between gap-3 flex-wrap cursor-pointer" onClick={() => setExpanded(!expanded)}>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <StatusBadge status={distribution.status} size="sm" />
            <span className="text-xs font-mono font-semibold bg-brand/15 text-brand px-2 py-0.5 rounded">
              {formatOrderNumber(distribution.order_number)}
            </span>
            {family ? (
              <Link
                to={`/families/${family.family_id}`}
                onClick={(e) => e.stopPropagation()}
                className="font-semibold hover:text-brand transition-colors"
              >
                {family.head_name}
              </Link>
            ) : (
              <span className="font-semibold text-slate-400">Unknown family</span>
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
              {new Date(when).toLocaleString()}
            </span>
            {family?.location_sector && <span>{family.location_sector}</span>}
            <span>by {worker ? `${worker.first_name} ${worker.last_name}` : distribution.delivered_by ?? distribution.assigned_to ?? '—'}</span>
            <span>
              {distribution.items_distributed.length} item type
              {distribution.items_distributed.length === 1 ? '' : 's'} · {totalQty} total
            </span>
          </div>
          <div className="text-xs text-slate-300 mt-1 line-clamp-1">
            {distribution.items_distributed.map((i) => `${i.item_name} ×${i.quantity}`).join(', ')}
          </div>
          {distribution.failure_reason && (
            <div className="text-xs text-priority-critical mt-1.5 italic">
              {distribution.status === 'failed' ? 'Failed: ' : 'Cancelled: '}
              {distribution.failure_reason}
            </div>
          )}
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

      {distribution.status === 'failed' && (
        <div className="mt-2 flex">
          <button
            onClick={onRetry}
            className="text-xs px-3 py-1.5 bg-priority-medium/15 hover:bg-priority-medium/25 text-priority-medium border border-priority-medium/30 rounded-lg flex items-center gap-1 font-semibold"
          >
            <RotateCcw size={12} /> Retry delivery
          </button>
        </div>
      )}

      {expanded && (
        <div className="mt-3 pt-3 border-t border-slate-700 space-y-2 text-xs">
          {distribution.notes && (
            <div>
              <div className="text-slate-400 font-medium mb-0.5">Creator notes</div>
              <div className="text-slate-200 italic">{distribution.notes}</div>
            </div>
          )}
          {distribution.ai_reasoning && (
            <div>
              <div className="text-slate-400 font-medium mb-0.5">AI reasoning at creation</div>
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
          <div className="text-slate-500 flex flex-wrap gap-x-3 gap-y-0.5">
            <span>Created {new Date(distribution.created_at).toLocaleString()}</span>
            {distribution.dispatched_at && (
              <span>· Dispatched {new Date(distribution.dispatched_at).toLocaleString()}</span>
            )}
            {distribution.delivered_at && (
              <span>· Delivered {new Date(distribution.delivered_at).toLocaleString()}</span>
            )}
            {distribution.closed_at && (
              <span>· Closed {new Date(distribution.closed_at).toLocaleString()}</span>
            )}
          </div>
        </div>
      )}
    </article>
  );
}

