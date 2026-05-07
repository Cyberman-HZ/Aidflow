// Medical conditions card with inline edit. Click the pencil icon and the
// body expands into a form for adding / removing conditions and editing
// the family-level "field notes" (used by field workers as free-text
// observations). The `last_medical_notes` and `last_delivery_notes` are
// captured at delivery time and remain read-only here.

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Edit2, Save, X, Heart, Plus, Trash2 } from 'lucide-react';
import { db } from '@/db/database';
import { computeRuleScore } from '@/services/priorityRules';
import { Card } from '@/components/Card';
import type { Family } from '@/types';

const SEVERITIES = [
  { value: 'critical', label: 'Critical' },
  { value: 'chronic', label: 'Chronic' },
  { value: 'moderate', label: 'Moderate' },
  { value: 'mild', label: 'Mild' },
  { value: 'monitoring', label: 'Monitoring' },
] as const;
type Severity = (typeof SEVERITIES)[number]['value'];

export default function EditableMedicalCard({ family }: { family: Family }) {
  const { t } = useTranslation();
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [conditions, setConditions] = useState<string[]>(family.medical_conditions);
  const [notes, setNotes] = useState(family.notes ?? '');
  const [newCondition, setNewCondition] = useState('');
  const [newSeverity, setNewSeverity] = useState<Severity>('chronic');

  const startEdit = () => {
    setConditions(family.medical_conditions);
    setNotes(family.notes ?? '');
    setNewCondition('');
    setNewSeverity('chronic');
    setError(null);
    setEditing(true);
  };

  const addCondition = () => {
    const trimmed = newCondition.trim();
    if (!trimmed) {
      setError('Condition name is required.');
      return;
    }
    const formatted = `${trimmed} (${newSeverity})`;
    if (conditions.some((c) => c.toLowerCase() === formatted.toLowerCase())) {
      setError('That condition is already on the list.');
      setNewCondition('');
      return;
    }
    setError(null);
    setConditions((arr) => [...arr, formatted]);
    setNewCondition('');
  };

  const removeCondition = (i: number) =>
    setConditions((arr) => arr.filter((_, idx) => idx !== i));

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const next: Family = {
        ...family,
        medical_conditions: conditions,
        notes: notes.trim(),
        last_updated: new Date().toISOString(),
      };
      // Severity tags ("(critical)", "(chronic)") feed into the rule engine,
      // so recompute priority on save.
      const r = computeRuleScore(next);
      next.priority_score = r.priority_score;
      next.priority_level = r.priority_level;
      next.ai_reason = r.reason;
      await db.families.put(next);
      setEditing(false);
    } catch (err) {
      const raw = err instanceof Error ? err.message : String(err);
      if (/QuotaExceeded/i.test(raw)) {
        setError('Could not save — your device is out of storage.');
      } else {
        setError('Could not save the changes. ' + raw);
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card
      title={
        <div className="flex items-center gap-2">{t('family_detail.medical')}</div>
      }
      action={
        editing ? null : (
          <button
            onClick={startEdit}
            className="touch-target px-2.5 py-1 hover:bg-surface-light text-slate-300 hover:text-brand rounded-md text-xs flex items-center gap-1"
            aria-label="Edit medical conditions"
          >
            <Edit2 size={12} /> {t('family_detail.edit')}
          </button>
        )
      }
      className="lg:col-span-2"
    >
      {!editing ? (
        <>
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
        </>
      ) : (
        <div className="space-y-3">
          {/* Existing conditions list */}
          {conditions.length === 0 ? (
            <p className="text-xs text-slate-500 italic">No conditions yet.</p>
          ) : (
            <ul className="space-y-1.5">
              {conditions.map((c, i) => (
                <li
                  key={i}
                  className={`flex items-center justify-between gap-2 px-3 py-1.5 rounded-lg border text-sm ${
                    c.toLowerCase().includes('critical')
                      ? 'bg-priority-critical/10 border-priority-critical/30 text-priority-critical'
                      : 'bg-surface-deep border-slate-700'
                  }`}
                >
                  <span>{c}</span>
                  <button
                    onClick={() => removeCondition(i)}
                    className="touch-target p-1 hover:bg-red-500/10 hover:text-red-400 rounded"
                    aria-label={`Remove ${c}`}
                  >
                    <Trash2 size={12} />
                  </button>
                </li>
              ))}
            </ul>
          )}

          {/* Add new condition */}
          <div className="flex flex-col sm:flex-row gap-1.5">
            <input
              value={newCondition}
              onChange={(e) => setNewCondition(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  addCondition();
                }
              }}
              placeholder="e.g. diabetes"
              className="flex-1 bg-surface-deep border border-slate-700 rounded-lg px-3 py-2 text-sm focus:border-brand outline-none"
            />
            <select
              value={newSeverity}
              onChange={(e) => setNewSeverity(e.target.value as Severity)}
              className="bg-surface-deep border border-slate-700 rounded-lg px-2 py-2 text-sm focus:border-brand outline-none capitalize"
              aria-label="Severity"
            >
              {SEVERITIES.map((s) => (
                <option key={s.value} value={s.value}>
                  {s.label}
                </option>
              ))}
            </select>
            <button
              onClick={addCondition}
              disabled={!newCondition.trim()}
              className="touch-target px-3 py-2 bg-surface-light hover:bg-slate-600 disabled:opacity-40 rounded-lg text-xs flex items-center justify-center gap-1"
            >
              <Plus size={12} /> Add
            </button>
          </div>

          {/* Field notes */}
          <div>
            <label className="block text-[11px] text-slate-400 mb-1 font-medium">
              Field notes
            </label>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={3}
              placeholder="Free-text observations from field workers..."
              className="w-full bg-surface-deep border border-slate-700 rounded-lg px-3 py-2 text-sm focus:border-brand outline-none"
            />
          </div>

          {error && (
            <div className="text-xs text-priority-critical bg-priority-critical/10 border border-priority-critical/30 rounded-lg px-3 py-2" role="alert">
              {error}
            </div>
          )}

          <div className="flex gap-2 pt-2 border-t border-slate-700">
            <button
              onClick={() => void save()}
              disabled={saving}
              className="touch-target px-3 py-1.5 bg-brand hover:bg-brand-dark disabled:opacity-50 text-white rounded-lg text-xs font-semibold flex items-center gap-1"
            >
              <Save size={12} />
              {saving ? t('common.saving') : t('common.save')}
            </button>
            <button
              onClick={() => setEditing(false)}
              disabled={saving}
              className="touch-target px-3 py-1.5 bg-surface-light hover:bg-slate-600 disabled:opacity-50 rounded-lg text-xs flex items-center gap-1"
            >
              <X size={12} /> {t('common.cancel')}
            </button>
          </div>
        </div>
      )}
    </Card>
  );
}
