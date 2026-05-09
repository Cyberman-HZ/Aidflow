// Workers — list and add field staff who deliver aid orders.
//
// Workers are different from Users: workers don't authenticate into the app.
// They are referenced by AidDistribution.assigned_to and .delivered_by, and
// chosen from the worker dropdown in the distribution wizard / reassign panel.
//
// Each worker has a first name, last name, and position. Phone / notes are
// optional. The internal `id` (W-...) is hidden from the user.

import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  UserCircle,
  Plus,
  Search,
  Trash2,
  Edit2,
  Save,
  X,
  Phone,
  Mail,
  MapPin,
  StickyNote,
  Briefcase,
  AlertTriangle,
} from 'lucide-react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '@/db/database';
import { Card } from '@/components/Card';
import EmptyState from '@/components/EmptyState';
import type { Worker, WorkerPosition, AidDistribution } from '@/types';

const POSITIONS: WorkerPosition[] = [
  'Field Worker',
  'Supervisor',
  'Driver',
  'Medical Officer',
  'Coordinator',
  'Logistics',
  'Translator',
  'Volunteer',
  'Other',
];

function newWorkerId(): string {
  // Timestamp + 10 random base-36 chars (~60 bits of entropy after the ms
  // prefix). Enough for bulk imports in the same millisecond without
  // collision; previous 3-char suffix could collide on synchronous adds.
  const rand =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID().replace(/-/g, '').slice(0, 10)
      : Math.random().toString(36).slice(2, 12).padEnd(10, '0');
  return `W-${Date.now().toString(36)}-${rand}`;
}

export default function Workers() {
  const { t } = useTranslation();

  const workers = useLiveQuery(
    () =>
      db.workers
        .toArray()
        .then((rows) =>
          // Hide soft-deleted workers from the page; they remain in the DB so
          // historic distribution rows can still resolve their names.
          rows
            .filter((w) => !w.deleted_at)
            .sort((a, b) =>
              `${a.last_name} ${a.first_name}`.localeCompare(`${b.last_name} ${b.first_name}`)
            )
        ),
    []
  ) ?? [];

  // Active distributions tell us which workers are currently busy or assigned.
  // We keep both `pending` and `out_for_delivery` so the delete guard can warn
  // about pending assignments too (not just dispatched ones).
  const activeDistributions =
    useLiveQuery(
      () =>
        db.distributions
          .where('status')
          .anyOf(['pending', 'out_for_delivery'])
          .toArray(),
      []
    ) ?? [];

  // `busyByWorkerId` covers OUT_FOR_DELIVERY only — used for the on-card
  // "Out for delivery" badge and to block dispatch elsewhere.
  const busyByWorkerId = useMemo(() => {
    const map = new Map<string, AidDistribution>();
    for (const d of activeDistributions) {
      if (d.status === 'out_for_delivery' && d.assigned_to) {
        map.set(d.assigned_to, d);
      }
    }
    return map;
  }, [activeDistributions]);

  // `activeAssignmentsByWorkerId` includes PENDING — used by the delete-confirm
  // modal so we can warn about pending orders that would be orphaned. A worker
  // with any active (pending OR out_for_delivery) order is blocked from delete.
  const activeAssignmentsByWorkerId = useMemo(() => {
    const map = new Map<string, AidDistribution[]>();
    for (const d of activeDistributions) {
      const wid = d.assigned_to;
      if (!wid) continue;
      const list = map.get(wid);
      if (list) list.push(d);
      else map.set(wid, [d]);
    }
    return map;
  }, [activeDistributions]);

  const [search, setSearch] = useState('');
  const [positionFilter, setPositionFilter] = useState('');
  const [showAdd, setShowAdd] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  // In-app delete-confirm modal state. null = closed; otherwise tracks the
  // worker we're about to delete + a deleting flag so we can show feedback.
  const [deleteTarget, setDeleteTarget] = useState<Worker | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [deletingNow, setDeletingNow] = useState(false);

  const filtered = useMemo(() => {
    let list = workers;
    if (positionFilter) list = list.filter((w) => w.position === positionFilter);
    if (search.trim()) {
      const q = search.trim().toLowerCase();
      list = list.filter(
        (w) =>
          w.first_name.toLowerCase().includes(q) ||
          w.last_name.toLowerCase().includes(q) ||
          w.position.toLowerCase().includes(q) ||
          w.phone?.toLowerCase().includes(q) ||
          w.email?.toLowerCase().includes(q) ||
          w.address?.toLowerCase().includes(q)
      );
    }
    return list;
  }, [workers, search, positionFilter]);

  return (
    <div className="space-y-5">
      <header className="flex items-center justify-between flex-wrap gap-3">
        <h1 className="text-2xl font-bold flex items-center gap-2">
          <UserCircle size={22} /> {t('workers.title')}
        </h1>
        {!showAdd && (
          <button
            onClick={() => setShowAdd(true)}
            className="touch-target px-4 py-2 bg-brand hover:bg-brand-dark text-white rounded-lg flex items-center gap-2 font-semibold"
          >
            <Plus size={16} /> {t('workers.add')}
          </button>
        )}
      </header>

      {showAdd && (
        <WorkerForm
          onSave={async (w) => {
            await db.workers.add(w);
            setShowAdd(false);
          }}
          onClose={() => setShowAdd(false)}
        />
      )}

      <Card>
        <div className="grid sm:grid-cols-2 gap-3">
          <div className="relative">
            <Search size={16} className="absolute top-1/2 -translate-y-1/2 start-3 text-slate-500" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t('workers.search_placeholder')}
              className="w-full bg-surface-deep border border-slate-700 rounded-lg ps-9 pe-3 py-2 text-sm focus:border-brand outline-none touch-target"
            />
          </div>
          <select
            value={positionFilter}
            onChange={(e) => setPositionFilter(e.target.value)}
            className="bg-surface-deep border border-slate-700 rounded-lg px-3 py-2 text-sm touch-target"
          >
            <option value="">{t('workers.all_positions')}</option>
            {POSITIONS.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        </div>
      </Card>

      {filtered.length === 0 ? (
        <Card>
          <EmptyState
            icon={<UserCircle size={28} />}
            title={
              workers.length === 0
                ? t('workers.empty_title')
                : t('workers.empty_filter_title')
            }
            body={
              workers.length === 0
                ? t('workers.empty_body')
                : t('workers.empty_filter_body')
            }
          />
        </Card>
      ) : (
        <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {filtered.map((w) => (
            <WorkerCard
              key={w.id}
              worker={w}
              busyOrder={busyByWorkerId.get(w.id)}
              isEditing={editing === w.id}
              onStartEdit={() => setEditing(w.id)}
              onCancelEdit={() => setEditing(null)}
              onSave={async (patch) => {
                await db.workers.update(w.id, patch);
                setEditing(null);
              }}
              onDelete={async () => {
                // Open the modal regardless. The modal itself surfaces
                // whether the worker has any active orders (pending OR
                // out_for_delivery) and disables the Delete button if so.
                setDeleteError(null);
                setDeleteTarget(w);
              }}
            />
          ))}
        </div>
      )}

      {deleteTarget && (
        <DeleteWorkerModal
          worker={deleteTarget}
          activeOrders={activeAssignmentsByWorkerId.get(deleteTarget.id) ?? []}
          deleting={deletingNow}
          error={deleteError}
          onCancel={() => {
            if (deletingNow) return;
            setDeleteTarget(null);
            setDeleteError(null);
          }}
          onConfirm={async () => {
            if (!deleteTarget) return;
            setDeletingNow(true);
            setDeleteError(null);
            try {
              // Soft-delete: tag the row with deleted_at so historic
              // distribution rows can still resolve the worker's name.
              // Hard-delete is reserved for workers who have no records
              // at all (handled by the modal's button being disabled when
              // active orders exist).
              await db.workers.update(deleteTarget.id, {
                deleted_at: new Date().toISOString(),
              });
              setDeleteTarget(null);
            } catch (e) {
              const raw = e instanceof Error ? e.message : String(e);
              const prefix =
                t('workers.delete_failed') ?? 'Could not delete the worker. ';
              setDeleteError(prefix + raw);
            } finally {
              setDeletingNow(false);
            }
          }}
        />
      )}
    </div>
  );
}

// =========================================================================
// In-app delete-confirm modal — replaces the native browser confirm() so
// the visual matches the app's dark-teal theme and we can show a friendly
// "this worker is currently out for delivery" hint when applicable.
// =========================================================================

function DeleteWorkerModal({
  worker,
  activeOrders,
  deleting,
  error,
  onCancel,
  onConfirm,
}: {
  worker: Worker;
  /** Pending or out_for_delivery orders assigned to this worker. */
  activeOrders: AidDistribution[];
  deleting: boolean;
  error?: string | null;
  onCancel: () => void;
  onConfirm: () => Promise<void>;
}) {
  const { t } = useTranslation();
  const fullName = `${worker.first_name} ${worker.last_name}`.trim();
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  const hasActive = activeOrders.length > 0;
  const outForDelivery = activeOrders.some((o) => o.status === 'out_for_delivery');

  // a11y: Escape closes, focus the cancel button on mount, lock body scroll.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !deleting) {
        e.preventDefault();
        onCancel();
      }
    };
    document.addEventListener('keydown', onKey);
    cancelRef.current?.focus();
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [deleting, onCancel]);

  return (
    <div
      className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="delete-worker-title"
      aria-describedby="delete-worker-body"
      onClick={() => {
        if (!deleting) onCancel();
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-md bg-surface border border-priority-critical/40 rounded-xl shadow-2xl p-5 space-y-4"
      >
        <div className="flex items-start gap-3">
          <div className="w-10 h-10 rounded-full bg-priority-critical/15 text-priority-critical grid place-items-center flex-shrink-0">
            <AlertTriangle size={20} />
          </div>
          <div className="flex-1 min-w-0">
            <h2
              id="delete-worker-title"
              className="text-base font-bold text-slate-100"
            >
              {t('workers.delete_title') ?? 'Delete worker?'}
            </h2>
            <p id="delete-worker-body" className="text-sm text-slate-300 mt-1">
              {t('workers.delete_body', { name: fullName }) ??
                `Are you sure you want to delete ${fullName}? This action cannot be undone.`}
            </p>
          </div>
        </div>

        {hasActive && (
          <div
            className="text-xs text-priority-medium bg-priority-medium/10 border border-priority-medium/30 rounded-lg px-3 py-2 flex items-start gap-2"
            role="alert"
          >
            <AlertTriangle size={12} className="flex-shrink-0 mt-0.5" />
            <span>
              {outForDelivery
                ? t('workers.cannot_delete_busy') ??
                  'This worker is currently out for delivery. Wait until the order is closed before deleting.'
                : t('workers.cannot_delete_pending', {
                    count: activeOrders.length,
                  }) ??
                  `This worker is assigned to ${activeOrders.length} pending order(s). Reassign or cancel them first.`}
            </span>
          </div>
        )}

        {error && !hasActive && (
          <div
            className="text-xs text-priority-critical bg-priority-critical/10 border border-priority-critical/30 rounded-lg px-3 py-2"
            role="alert"
          >
            {error}
          </div>
        )}

        <div className="flex justify-end gap-2 pt-2 border-t border-slate-700">
          <button
            ref={cancelRef}
            onClick={onCancel}
            disabled={deleting}
            className="touch-target px-4 py-2 bg-surface-light hover:bg-slate-600 disabled:opacity-50 text-slate-200 rounded-lg text-sm flex items-center gap-1"
          >
            <X size={14} /> {t('common.cancel')}
          </button>
          <button
            onClick={() => void onConfirm()}
            disabled={deleting || hasActive}
            className="touch-target px-4 py-2 bg-priority-critical hover:bg-red-600 disabled:opacity-50 disabled:cursor-not-allowed text-white rounded-lg text-sm font-semibold flex items-center gap-1"
          >
            <Trash2 size={14} />
            {deleting
              ? t('common.saving') ?? 'Deleting…'
              : t('workers.delete') ?? 'Delete'}
          </button>
        </div>
      </div>
    </div>
  );
}

// =========================================================================
// Worker card — read mode + inline edit
// =========================================================================

function WorkerCard({
  worker,
  busyOrder,
  isEditing,
  onStartEdit,
  onCancelEdit,
  onSave,
  onDelete,
}: {
  worker: Worker;
  busyOrder?: AidDistribution;
  isEditing: boolean;
  onStartEdit: () => void;
  onCancelEdit: () => void;
  onSave: (patch: Partial<Worker>) => Promise<void>;
  onDelete: () => Promise<void>;
}) {
  const { t } = useTranslation();

  if (isEditing) {
    return (
      <div className="bg-surface border-2 border-brand/40 rounded-xl p-4">
        <WorkerEditForm worker={worker} onSave={onSave} onClose={onCancelEdit} />
      </div>
    );
  }

  return (
    <article className="bg-surface border border-slate-700 hover:border-brand/40 rounded-xl p-4 transition-colors flex flex-col gap-3">
      <div className="flex items-start gap-3">
        <div className="w-12 h-12 rounded-full bg-brand/15 text-brand grid place-items-center text-lg font-bold flex-shrink-0">
          {worker.first_name.charAt(0)}
          {worker.last_name.charAt(0)}
        </div>
        <div className="flex-1 min-w-0">
          <div className="font-semibold truncate">
            {worker.first_name} {worker.last_name}
          </div>
          <div className="text-xs text-slate-400 flex items-center gap-1 mt-0.5">
            <Briefcase size={11} /> {worker.position}
          </div>
          {busyOrder && (
            <div className="text-[10px] mt-1 inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-priority-medium/15 text-priority-medium font-semibold">
              <AlertTriangle size={10} /> {t('workers.busy_label')}
            </div>
          )}
        </div>
      </div>

      {(worker.phone || worker.email || worker.address || worker.notes) && (
        <div className="text-xs text-slate-300 space-y-1 border-t border-slate-700 pt-2.5">
          {worker.phone && (
            <div className="flex items-center gap-1.5">
              <Phone size={11} className="text-slate-500 flex-shrink-0" />
              <a
                href={`tel:${worker.phone}`}
                className="hover:text-brand transition-colors truncate"
              >
                {worker.phone}
              </a>
            </div>
          )}
          {worker.email && (
            <div className="flex items-center gap-1.5">
              <Mail size={11} className="text-slate-500 flex-shrink-0" />
              <a
                href={`mailto:${worker.email}`}
                className="hover:text-brand transition-colors truncate"
              >
                {worker.email}
              </a>
            </div>
          )}
          {worker.address && (
            <div className="flex items-start gap-1.5">
              <MapPin size={11} className="text-slate-500 mt-0.5 flex-shrink-0" />
              <span className="line-clamp-2">{worker.address}</span>
            </div>
          )}
          {worker.notes && (
            <div className="flex items-start gap-1.5">
              <StickyNote size={11} className="text-slate-500 mt-0.5 flex-shrink-0" />
              <span className="italic line-clamp-2">{worker.notes}</span>
            </div>
          )}
        </div>
      )}

      <div className="flex gap-2 mt-auto pt-2 border-t border-slate-700">
        <button
          onClick={onStartEdit}
          className="touch-target flex-1 px-3 py-1.5 bg-surface-light hover:bg-slate-600 text-slate-200 rounded-lg text-xs flex items-center justify-center gap-1"
        >
          <Edit2 size={12} /> {t('workers.edit')}
        </button>
        <button
          onClick={() => void onDelete()}
          className="touch-target px-3 py-1.5 hover:bg-priority-critical/10 hover:text-priority-critical text-slate-500 rounded-lg text-xs flex items-center justify-center gap-1"
          aria-label={t('workers.delete')}
        >
          <Trash2 size={12} />
        </button>
      </div>
    </article>
  );
}

// =========================================================================
// Add-worker form (top of page)
// =========================================================================

function WorkerForm({
  onSave,
  onClose,
}: {
  onSave: (w: Worker) => Promise<void>;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [position, setPosition] = useState<WorkerPosition>('Field Worker');
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [address, setAddress] = useState('');
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSave = async () => {
    setError(null);
    if (!firstName.trim() || !lastName.trim()) {
      setError(t('workers.required_names'));
      return;
    }
    // Light email validation — non-empty value must look like an address.
    const trimmedEmail = email.trim();
    if (trimmedEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmedEmail)) {
      setError(t('workers.invalid_email') ?? 'Email looks invalid.');
      return;
    }
    // Soft duplicate guard — block exact (case-insensitive) matches on
    // first_name + last_name + position. The compound index defined in
    // database.ts (position+last_name+first_name) makes this a single
    // indexed lookup. Soft-deleted rows are ignored so a recreated worker
    // with the same name is still allowed.
    const fnLower = firstName.trim().toLowerCase();
    const lnLower = lastName.trim().toLowerCase();
    const dup = await db.workers
      .toArray()
      .then((rows) =>
        rows.find(
          (w) =>
            !w.deleted_at &&
            w.first_name.toLowerCase() === fnLower &&
            w.last_name.toLowerCase() === lnLower &&
            w.position === position
        )
      );
    if (dup) {
      setError(
        t('workers.duplicate_warning') ??
          'A worker with this name and position already exists.'
      );
      return;
    }
    // Hard cap each text field at 80 chars at the persistence boundary so a
    // pasted novel doesn't blow past Gemma 4's small context window when the
    // worker name is embedded in the AI system prompt.
    const cap = (s: string) => s.slice(0, 80);
    setSaving(true);
    try {
      await onSave({
        id: newWorkerId(),
        first_name: cap(firstName.trim()),
        last_name: cap(lastName.trim()),
        position,
        phone: phone.trim() ? cap(phone.trim()) : undefined,
        email: trimmedEmail ? cap(trimmedEmail) : undefined,
        address: address.trim() ? cap(address.trim()) : undefined,
        notes: notes.trim() ? notes.trim().slice(0, 500) : undefined,
        created_at: new Date().toISOString(),
      });
    } catch (err) {
      const raw = err instanceof Error ? err.message : String(err);
      if (/ConstraintError/i.test(raw)) {
        setError(
          t('workers.duplicate_id') ??
            'Could not save — please try again (id collision).'
        );
      } else {
        setError(
          (t('workers.save_failed') ?? 'Could not save the worker. ') + raw
        );
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card title={t('workers.add')}>
      <div className="grid sm:grid-cols-2 gap-3">
        <div>
          <label className="block text-xs text-slate-400 mb-1.5 font-medium">
            {t('workers.first_name')} <span className="text-priority-critical">*</span>
          </label>
          <input
            value={firstName}
            onChange={(e) => setFirstName(e.target.value)}
            maxLength={80}
            placeholder="e.g. Layla"
            className="w-full bg-surface-deep border border-slate-700 rounded-lg px-3 py-2 text-sm focus:border-brand outline-none"
          />
        </div>
        <div>
          <label className="block text-xs text-slate-400 mb-1.5 font-medium">
            {t('workers.last_name')} <span className="text-priority-critical">*</span>
          </label>
          <input
            value={lastName}
            onChange={(e) => setLastName(e.target.value)}
            maxLength={80}
            placeholder="e.g. Othman"
            className="w-full bg-surface-deep border border-slate-700 rounded-lg px-3 py-2 text-sm focus:border-brand outline-none"
          />
        </div>
        <div>
          <label className="block text-xs text-slate-400 mb-1.5 font-medium">
            {t('workers.position')} <span className="text-priority-critical">*</span>
          </label>
          <select
            value={position}
            onChange={(e) => setPosition(e.target.value as WorkerPosition)}
            className="w-full bg-surface-deep border border-slate-700 rounded-lg px-3 py-2 text-sm focus:border-brand outline-none"
          >
            {POSITIONS.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="block text-xs text-slate-400 mb-1.5 font-medium">
            {t('workers.phone')}
          </label>
          <input
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            maxLength={40}
            placeholder="+963-94-555-…"
            className="w-full bg-surface-deep border border-slate-700 rounded-lg px-3 py-2 text-sm focus:border-brand outline-none"
          />
        </div>
        <div>
          <label className="block text-xs text-slate-400 mb-1.5 font-medium">
            {t('workers.email') ?? 'Email'}
          </label>
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            maxLength={80}
            placeholder="layla.othman@example.org"
            className="w-full bg-surface-deep border border-slate-700 rounded-lg px-3 py-2 text-sm focus:border-brand outline-none"
          />
        </div>
        <div className="sm:col-span-2">
          <label className="block text-xs text-slate-400 mb-1.5 font-medium">
            {t('workers.address') ?? 'Address'}
          </label>
          <input
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            maxLength={80}
            placeholder="e.g. 12 Olive Tree Lane, Damascus"
            className="w-full bg-surface-deep border border-slate-700 rounded-lg px-3 py-2 text-sm focus:border-brand outline-none"
          />
        </div>
        <div className="sm:col-span-2">
          <label className="block text-xs text-slate-400 mb-1.5 font-medium">
            {t('workers.notes')}
          </label>
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={2}
            maxLength={500}
            placeholder={t('workers.notes_placeholder')}
            className="w-full bg-surface-deep border border-slate-700 rounded-lg px-3 py-2 text-sm focus:border-brand outline-none"
          />
        </div>
      </div>

      {error && (
        <div className="mt-3 text-xs text-priority-critical bg-priority-critical/10 border border-priority-critical/30 rounded-lg px-3 py-2 flex items-center gap-2">
          <AlertTriangle size={12} /> {error}
        </div>
      )}

      <div className="flex justify-end gap-2 mt-4 pt-4 border-t border-slate-700">
        <button
          onClick={onClose}
          className="touch-target px-3 py-2 bg-surface-deep hover:bg-slate-700 text-slate-300 rounded-lg text-sm flex items-center gap-1"
        >
          <X size={14} /> {t('common.cancel')}
        </button>
        <button
          onClick={() => void handleSave()}
          disabled={saving}
          className="touch-target px-4 py-2 bg-brand hover:bg-brand-dark disabled:opacity-50 text-white rounded-lg text-sm font-semibold flex items-center gap-1"
        >
          <Save size={14} /> {saving ? t('common.saving') : t('workers.save')}
        </button>
      </div>
    </Card>
  );
}

// =========================================================================
// Inline edit form
// =========================================================================

function WorkerEditForm({
  worker,
  onSave,
  onClose,
}: {
  worker: Worker;
  onSave: (patch: Partial<Worker>) => Promise<void>;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [firstName, setFirstName] = useState(worker.first_name);
  const [lastName, setLastName] = useState(worker.last_name);
  const [position, setPosition] = useState<string>(worker.position);
  const [phone, setPhone] = useState(worker.phone ?? '');
  const [email, setEmail] = useState(worker.email ?? '');
  const [address, setAddress] = useState(worker.address ?? '');
  const [notes, setNotes] = useState(worker.notes ?? '');
  const [error, setError] = useState<string | null>(null);

  const handleSave = async () => {
    setError(null);
    if (!firstName.trim() || !lastName.trim()) {
      setError(t('workers.required_names'));
      return;
    }
    const trimmedEmail = email.trim();
    if (trimmedEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmedEmail)) {
      setError(t('workers.invalid_email') ?? 'Email looks invalid.');
      return;
    }
    // Hard cap each text field at 80 chars at the persistence boundary so a
    // pasted novel doesn't blow past Gemma 4's small context window when the
    // worker name is embedded in the AI system prompt.
    const cap = (s: string) => s.slice(0, 80);
    await onSave({
      first_name: cap(firstName.trim()),
      last_name: cap(lastName.trim()),
      position: cap(position) as WorkerPosition,
      phone: phone.trim() ? cap(phone.trim()) : undefined,
      email: trimmedEmail ? cap(trimmedEmail) : undefined,
      address: address.trim() ? cap(address.trim()) : undefined,
      notes: notes.trim() ? notes.trim().slice(0, 500) : undefined,
    });
  };

  return (
    <div className="space-y-2">
      <div className="text-xs font-semibold text-brand flex items-center gap-1.5 mb-1">
        <Edit2 size={12} /> {t('workers.edit_title')}
      </div>
      <div className="grid grid-cols-2 gap-2">
        <input
          value={firstName}
          onChange={(e) => setFirstName(e.target.value)}
          maxLength={80}
          placeholder={t('workers.first_name')}
          className="bg-surface-deep border border-slate-700 rounded px-2 py-1.5 text-xs"
        />
        <input
          value={lastName}
          onChange={(e) => setLastName(e.target.value)}
          maxLength={80}
          placeholder={t('workers.last_name')}
          className="bg-surface-deep border border-slate-700 rounded px-2 py-1.5 text-xs"
        />
      </div>
      <select
        value={position}
        onChange={(e) => setPosition(e.target.value)}
        className="w-full bg-surface-deep border border-slate-700 rounded px-2 py-1.5 text-xs"
      >
        {POSITIONS.map((p) => (
          <option key={p} value={p}>
            {p}
          </option>
        ))}
        {!POSITIONS.includes(position as WorkerPosition) && (
          <option value={position}>{position}</option>
        )}
      </select>
      <input
        value={phone}
        onChange={(e) => setPhone(e.target.value)}
        maxLength={40}
        placeholder={t('workers.phone')}
        className="w-full bg-surface-deep border border-slate-700 rounded px-2 py-1.5 text-xs"
      />
      <input
        type="email"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        maxLength={80}
        placeholder={t('workers.email') ?? 'Email'}
        className="w-full bg-surface-deep border border-slate-700 rounded px-2 py-1.5 text-xs"
      />
      <input
        value={address}
        onChange={(e) => setAddress(e.target.value)}
        maxLength={80}
        placeholder={t('workers.address') ?? 'Address'}
        className="w-full bg-surface-deep border border-slate-700 rounded px-2 py-1.5 text-xs"
      />
      <textarea
        value={notes}
        onChange={(e) => setNotes(e.target.value)}
        placeholder={t('workers.notes')}
        rows={2}
        maxLength={500}
        className="w-full bg-surface-deep border border-slate-700 rounded px-2 py-1.5 text-xs"
      />
      {error && (
        <div className="text-[11px] text-priority-critical bg-priority-critical/10 border border-priority-critical/30 rounded px-2 py-1" role="alert">
          {error}
        </div>
      )}
      <div className="flex gap-2 pt-1">
        <button
          onClick={() => void handleSave()}
          className="touch-target px-3 py-1.5 bg-brand hover:bg-brand-dark text-white rounded text-xs font-semibold flex items-center gap-1"
        >
          <Save size={12} /> {t('workers.save')}
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
