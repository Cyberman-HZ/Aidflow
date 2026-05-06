// Workers — list and add field staff who deliver aid orders.
//
// Workers are different from Users: workers don't authenticate into the app.
// They are referenced by AidDistribution.assigned_to and .delivered_by, and
// chosen from the worker dropdown in the distribution wizard / reassign panel.
//
// Each worker has a first name, last name, and position. Phone / notes are
// optional. The internal `id` (W-...) is hidden from the user.

import { useMemo, useState } from 'react';
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
  // Short timestamp-based id; the user never sees this.
  return `W-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 5)}`;
}

export default function Workers() {
  const { t } = useTranslation();

  const workers = useLiveQuery(
    () =>
      db.workers
        .toArray()
        .then((rows) =>
          rows.sort((a, b) =>
            `${a.last_name} ${a.first_name}`.localeCompare(`${b.last_name} ${b.first_name}`)
          )
        ),
    []
  ) ?? [];

  // Active distributions tell us which workers are currently busy or assigned.
  const activeDistributions =
    useLiveQuery(
      () =>
        db.distributions
          .where('status')
          .anyOf(['pending', 'out_for_delivery'])
          .toArray(),
      []
    ) ?? [];

  const allDistributions = useLiveQuery(() => db.distributions.toArray()) ?? [];

  // Per-worker stats: assigned (pending+out), delivered, failed.
  const stats = useMemo(() => {
    const map = new Map<
      string,
      { assigned: number; out: number; delivered: number; failed: number; total: number }
    >();
    for (const w of workers) {
      map.set(w.id, { assigned: 0, out: 0, delivered: 0, failed: 0, total: 0 });
    }
    for (const d of allDistributions) {
      const wid = d.assigned_to ?? d.delivered_by;
      if (!wid || !map.has(wid)) continue;
      const s = map.get(wid)!;
      s.total++;
      if (d.status === 'out_for_delivery') s.out++;
      if (d.status === 'pending' || d.status === 'out_for_delivery') s.assigned++;
      if (d.status === 'delivered') s.delivered++;
      if (d.status === 'failed') s.failed++;
    }
    return map;
  }, [workers, allDistributions]);

  const busyByWorkerId = useMemo(() => {
    const map = new Map<string, AidDistribution>();
    for (const d of activeDistributions) {
      if (d.status === 'out_for_delivery' && d.assigned_to) {
        map.set(d.assigned_to, d);
      }
    }
    return map;
  }, [activeDistributions]);

  const [search, setSearch] = useState('');
  const [positionFilter, setPositionFilter] = useState('');
  const [showAdd, setShowAdd] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);

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
          w.phone?.toLowerCase().includes(q)
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
              stats={stats.get(w.id)}
              isEditing={editing === w.id}
              onStartEdit={() => setEditing(w.id)}
              onCancelEdit={() => setEditing(null)}
              onSave={async (patch) => {
                await db.workers.update(w.id, patch);
                setEditing(null);
              }}
              onDelete={async () => {
                if (busyByWorkerId.has(w.id)) {
                  alert(t('workers.cannot_delete_busy'));
                  return;
                }
                if (!confirm(t('workers.confirm_delete', { name: `${w.first_name} ${w.last_name}` }))) return;
                await db.workers.delete(w.id);
              }}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// =========================================================================
// Worker card — read mode + inline edit
// =========================================================================

function WorkerCard({
  worker,
  busyOrder,
  stats,
  isEditing,
  onStartEdit,
  onCancelEdit,
  onSave,
  onDelete,
}: {
  worker: Worker;
  busyOrder?: AidDistribution;
  stats?: { assigned: number; out: number; delivered: number; failed: number; total: number };
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

      {(worker.phone || worker.notes) && (
        <div className="text-xs text-slate-300 space-y-1 border-t border-slate-700 pt-2.5">
          {worker.phone && (
            <div className="flex items-center gap-1.5">
              <Phone size={11} className="text-slate-500" />
              <span>{worker.phone}</span>
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

      {stats && stats.total > 0 && (
        <div className="grid grid-cols-3 gap-2 border-t border-slate-700 pt-2.5 text-center">
          <div>
            <div className="text-base font-bold text-priority-medium">{stats.assigned}</div>
            <div className="text-[10px] text-slate-500 uppercase">{t('workers.stat_assigned')}</div>
          </div>
          <div>
            <div className="text-base font-bold text-priority-normal">{stats.delivered}</div>
            <div className="text-[10px] text-slate-500 uppercase">{t('workers.stat_delivered')}</div>
          </div>
          <div>
            <div className="text-base font-bold text-priority-critical">{stats.failed}</div>
            <div className="text-[10px] text-slate-500 uppercase">{t('workers.stat_failed')}</div>
          </div>
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
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSave = async () => {
    setError(null);
    if (!firstName.trim() || !lastName.trim()) {
      setError(t('workers.required_names'));
      return;
    }
    setSaving(true);
    try {
      await onSave({
        id: newWorkerId(),
        first_name: firstName.trim(),
        last_name: lastName.trim(),
        position,
        phone: phone.trim() || undefined,
        notes: notes.trim() || undefined,
        created_at: new Date().toISOString(),
      });
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
            placeholder="+963-94-555-…"
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
  const [notes, setNotes] = useState(worker.notes ?? '');

  const handleSave = async () => {
    if (!firstName.trim() || !lastName.trim()) return;
    await onSave({
      first_name: firstName.trim(),
      last_name: lastName.trim(),
      position: position as WorkerPosition,
      phone: phone.trim() || undefined,
      notes: notes.trim() || undefined,
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
          placeholder={t('workers.first_name')}
          className="bg-surface-deep border border-slate-700 rounded px-2 py-1.5 text-xs"
        />
        <input
          value={lastName}
          onChange={(e) => setLastName(e.target.value)}
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
        placeholder={t('workers.phone')}
        className="w-full bg-surface-deep border border-slate-700 rounded px-2 py-1.5 text-xs"
      />
      <textarea
        value={notes}
        onChange={(e) => setNotes(e.target.value)}
        placeholder={t('workers.notes')}
        rows={2}
        className="w-full bg-surface-deep border border-slate-700 rounded px-2 py-1.5 text-xs"
      />
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
