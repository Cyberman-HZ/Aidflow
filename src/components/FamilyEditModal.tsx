// Family edit / create modal.
//
// Used by the Families list to:
//   * edit an existing family (pencil icon on each row)
//   * add a new family (+ Add family button in the page header)
//
// On save, the priority is recomputed via computeRuleScore so the
// priority_score / priority_level / ai_reason cache stays in sync with
// whatever the user changed (members, medical conditions, displacement, etc.).
//
// family_id is immutable once a family exists. For new families it's auto
// generated as "F-{timestamp-base36}" so it's short and unique.

import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  X,
  Save,
  Plus,
  Trash2,
  AlertTriangle,
  UserPlus,
  Edit2,
} from 'lucide-react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '@/db/database';
import { computeRuleScore } from '@/services/priorityRules';
import type {
  Family,
  DisplacementStatus,
  IncomeLevel,
} from '@/types';

const DISPLACEMENT_OPTIONS: DisplacementStatus[] = [
  'resident',
  'recently_displaced',
  'refugee',
];

const INCOME_OPTIONS: IncomeLevel[] = ['none', 'minimal', 'moderate'];

// Severity tags appended to each free-typed medical condition. The priority
// engine uses these (see priorityRules.ts) — "critical" adds +25 to the
// family's score, "chronic" adds +10. The other levels are descriptive.
const MEDICAL_SEVERITY = [
  { value: 'critical', label: 'Critical' },
  { value: 'chronic', label: 'Chronic' },
  { value: 'moderate', label: 'Moderate' },
  { value: 'mild', label: 'Mild' },
  { value: 'monitoring', label: 'Monitoring' },
] as const;
type Severity = (typeof MEDICAL_SEVERITY)[number]['value'];

// Legacy export kept so nothing else breaks if anyone imported it. The list
// itself is no longer used in the UI.
const MEDICAL_TEMPLATES = [
  'malnutrition (critical)',
  'malnutrition (chronic)',
  'cholera exposure (critical)',
  'tuberculosis (critical)',
  'diabetes (chronic)',
  'diabetes (critical)',
  'hypertension (chronic)',
  'asthma (chronic)',
  'anemia (chronic)',
  'malaria (chronic)',
  'pregnancy complications (critical)',
];

function newFamilyId(): string {
  return `F-${Date.now().toString(36).toUpperCase()}`;
}

export default function FamilyEditModal({
  existing,
  onClose,
}: {
  existing?: Family;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const isEditing = !!existing;

  const [headName, setHeadName] = useState(existing?.head_name ?? '');
  const [memberCount, setMemberCount] = useState(existing?.member_count ?? 1);
  const [childrenUnder5, setChildrenUnder5] = useState(existing?.children_under_5 ?? 0);
  const [elderlyCount, setElderlyCount] = useState(existing?.elderly_count ?? 0);
  const [hasPregnant, setHasPregnant] = useState(!!existing?.has_pregnant_member);
  const [medicalConditions, setMedicalConditions] = useState<string[]>(
    existing?.medical_conditions ?? []
  );
  const [displacementStatus, setDisplacementStatus] = useState<DisplacementStatus>(
    existing?.displacement_status ?? 'resident'
  );
  const [incomeLevel, setIncomeLevel] = useState<IncomeLevel>(
    existing?.income_level ?? 'minimal'
  );
  const [locationSector, setLocationSector] = useState(existing?.location_sector ?? '');
  const [street, setStreet] = useState(existing?.street ?? '');
  const [city, setCity] = useState(existing?.city ?? '');
  const [notes, setNotes] = useState(existing?.notes ?? '');
  const [latStr, setLatStr] = useState(
    existing?.coordinates?.lat?.toString() ?? ''
  );
  const [lngStr, setLngStr] = useState(
    existing?.coordinates?.lng?.toString() ?? ''
  );
  const [newCondition, setNewCondition] = useState('');
  const [newSeverity, setNewSeverity] = useState<Severity>('chronic');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // Pull all existing sector names so the user can pick from what's already
  // in the database (avoids typos / sector fragmentation).
  const allFamilies = useLiveQuery(() => db.families.toArray()) ?? [];
  const existingSectors = useMemo(
    () =>
      Array.from(
        new Set(
          allFamilies
            .map((f) => f.location_sector?.trim())
            .filter((s): s is string => !!s)
        )
      ).sort((a, b) => a.localeCompare(b)),
    [allFamilies]
  );

  // Adds a condition formatted as "name (severity)" so the priority engine
  // can detect "(critical)" and "(chronic)" downstream.
  const addCondition = () => {
    const trimmed = newCondition.trim();
    if (!trimmed) return;
    const formatted = `${trimmed} (${newSeverity})`;
    if (medicalConditions.includes(formatted)) {
      setNewCondition('');
      return;
    }
    setMedicalConditions((arr) => [...arr, formatted]);
    setNewCondition('');
  };

  const removeCondition = (i: number) =>
    setMedicalConditions((arr) => arr.filter((_, idx) => idx !== i));

  const validate = (): string | null => {
    if (!headName.trim()) return 'Head of household name is required.';
    if (!locationSector.trim()) return 'Location sector is required.';
    if (memberCount < 1) return 'Member count must be at least 1.';
    if (childrenUnder5 < 0 || elderlyCount < 0)
      return 'Counts cannot be negative.';
    if (childrenUnder5 + elderlyCount > memberCount)
      return 'Children + elderly cannot exceed total members.';
    if (latStr.trim() && isNaN(Number(latStr)))
      return 'Latitude must be a number (or leave blank).';
    if (lngStr.trim() && isNaN(Number(lngStr)))
      return 'Longitude must be a number (or leave blank).';
    return null;
  };

  const handleSave = async () => {
    const err = validate();
    if (err) {
      setError(err);
      return;
    }
    setError(null);
    setSaving(true);
    try {
      const now = new Date().toISOString();
      const coords =
        latStr.trim() && lngStr.trim()
          ? { lat: Number(latStr), lng: Number(lngStr) }
          : undefined;

      // Build the family row preserving cached AI fields when editing.
      const family: Family = {
        ...(existing ?? {
          family_id: newFamilyId(),
        }),
        family_id: existing?.family_id ?? newFamilyId(),
        head_name: headName.trim(),
        member_count: memberCount,
        children_under_5: childrenUnder5,
        elderly_count: elderlyCount,
        has_pregnant_member: hasPregnant,
        medical_conditions: medicalConditions,
        displacement_status: displacementStatus,
        income_level: incomeLevel,
        location_sector: locationSector.trim(),
        street: street.trim() || undefined,
        city: city.trim() || undefined,
        coordinates: coords,
        notes: notes.trim(),
        last_updated: now,
      };

      // Recompute the rule-based priority so the new data is reflected
      // immediately. The user can still re-run the AI prioritization
      // from the Families page header for a more nuanced score.
      const r = computeRuleScore(family);
      family.priority_score = r.priority_score;
      family.priority_level = r.priority_level;
      family.ai_reason = r.reason;
      // Only seed recommended_items if the family doesn't already have a
      // worker-curated list (avoid clobbering "next visit needs").
      if (!family.recommended_items?.length) {
        family.recommended_items = r.recommended_items;
      }

      await db.families.put(family);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="family-edit-title"
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-2xl bg-surface border border-brand/40 rounded-xl shadow-2xl flex flex-col max-h-[90vh]"
      >
        <header className="px-5 py-3 border-b border-slate-700 flex items-start justify-between gap-3">
          <div>
            <h2
              id="family-edit-title"
              className="text-base font-bold flex items-center gap-2 text-brand"
            >
              {isEditing ? <Edit2 size={18} /> : <UserPlus size={18} />}
              {isEditing
                ? t('families_edit.edit_title')
                : t('families_edit.add_title')}
            </h2>
            {existing && (
              <p className="text-xs text-slate-400 mt-0.5">
                {existing.family_id} · last updated{' '}
                {new Date(existing.last_updated).toLocaleString()}
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

        <div className="px-5 py-4 space-y-4 overflow-y-auto">
          {/* Head of household */}
          <Field label={t('families_edit.head_name')} required>
            <input
              value={headName}
              onChange={(e) => setHeadName(e.target.value)}
              placeholder="e.g. Layla Karim"
              className="w-full bg-surface-deep border border-slate-700 rounded-lg px-3 py-2 text-sm focus:border-brand outline-none"
            />
          </Field>

          {/* Location sector — pick from sectors that already exist on other
              families. Adding new sectors here is intentionally not supported;
              sectors are part of the operational map and shouldn't be created
              ad-hoc from a family form. */}
          <Field label={t('families_edit.location_sector')} required>
            <select
              value={locationSector}
              onChange={(e) => setLocationSector(e.target.value)}
              className="w-full bg-surface-deep border border-slate-700 rounded-lg px-3 py-2 text-sm focus:border-brand outline-none"
            >
              <option value="">— {t('families_edit.sector_pick')} —</option>
              {existingSectors.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
              {/* Preserve any sector this family already has, even if no
                  other family currently uses it (e.g. it was renamed). */}
              {locationSector &&
                !existingSectors.includes(locationSector) && (
                  <option value={locationSector}>{locationSector}</option>
                )}
            </select>
          </Field>

          {/* Address — street + city, both optional */}
          <div className="grid sm:grid-cols-2 gap-3">
            <Field label={t('families_edit.street')}>
              <input
                value={street}
                onChange={(e) => setStreet(e.target.value)}
                placeholder={t('families_edit.street_placeholder') ?? ''}
                className="w-full bg-surface-deep border border-slate-700 rounded-lg px-3 py-2 text-sm focus:border-brand outline-none"
              />
            </Field>
            <Field label={t('families_edit.city')}>
              <input
                value={city}
                onChange={(e) => setCity(e.target.value)}
                placeholder={t('families_edit.city_placeholder') ?? ''}
                className="w-full bg-surface-deep border border-slate-700 rounded-lg px-3 py-2 text-sm focus:border-brand outline-none"
              />
            </Field>
          </div>

          {/* Member counts */}
          <div className="grid sm:grid-cols-3 gap-3">
            <Field label={t('families_edit.member_count')} required>
              <input
                type="number"
                min={1}
                value={memberCount}
                onChange={(e) => setMemberCount(Math.max(1, +e.target.value))}
                className="w-full bg-surface-deep border border-slate-700 rounded-lg px-3 py-2 text-sm focus:border-brand outline-none"
              />
            </Field>
            <Field label={t('families_edit.children_under5')}>
              <input
                type="number"
                min={0}
                value={childrenUnder5}
                onChange={(e) => setChildrenUnder5(Math.max(0, +e.target.value))}
                className="w-full bg-surface-deep border border-slate-700 rounded-lg px-3 py-2 text-sm focus:border-brand outline-none"
              />
            </Field>
            <Field label={t('families_edit.elderly_count')}>
              <input
                type="number"
                min={0}
                value={elderlyCount}
                onChange={(e) => setElderlyCount(Math.max(0, +e.target.value))}
                className="w-full bg-surface-deep border border-slate-700 rounded-lg px-3 py-2 text-sm focus:border-brand outline-none"
              />
            </Field>
          </div>

          {/* Pregnant checkbox */}
          <label className="flex items-center gap-2 text-sm cursor-pointer bg-surface-light/50 border border-slate-700 rounded-lg px-3 py-2 hover:border-brand/40 transition-colors">
            <input
              type="checkbox"
              checked={hasPregnant}
              onChange={(e) => setHasPregnant(e.target.checked)}
              className="accent-brand"
            />
            <span>{t('families_edit.has_pregnant_member')}</span>
          </label>

          {/* Status fields */}
          <div className="grid sm:grid-cols-2 gap-3">
            <Field label={t('families_edit.displacement_status')}>
              <select
                value={displacementStatus}
                onChange={(e) =>
                  setDisplacementStatus(e.target.value as DisplacementStatus)
                }
                className="w-full bg-surface-deep border border-slate-700 rounded-lg px-3 py-2 text-sm focus:border-brand outline-none"
              >
                {DISPLACEMENT_OPTIONS.map((opt) => (
                  <option key={opt} value={opt}>
                    {opt.replace('_', ' ')}
                  </option>
                ))}
              </select>
            </Field>
            <Field label={t('families_edit.income_level')}>
              <select
                value={incomeLevel}
                onChange={(e) => setIncomeLevel(e.target.value as IncomeLevel)}
                className="w-full bg-surface-deep border border-slate-700 rounded-lg px-3 py-2 text-sm focus:border-brand outline-none"
              >
                {INCOME_OPTIONS.map((opt) => (
                  <option key={opt} value={opt}>
                    {opt}
                  </option>
                ))}
              </select>
            </Field>
          </div>

          {/* Medical conditions */}
          <Field label={t('families_edit.medical_conditions')}>
            <p className="text-xs text-slate-400 mb-1.5">
              {t('families_edit.medical_conditions_hint')}
            </p>
            {medicalConditions.length > 0 && (
              <div className="flex flex-wrap gap-1.5 mb-2">
                {medicalConditions.map((c, i) => {
                  const critical = c.toLowerCase().includes('critical');
                  return (
                    <span
                      key={i}
                      className={`text-xs px-2 py-1 rounded-full border flex items-center gap-1 ${
                        critical
                          ? 'bg-priority-critical/15 border-priority-critical/30 text-priority-critical'
                          : 'bg-surface-light border-slate-600 text-slate-200'
                      }`}
                    >
                      {c}
                      <button
                        onClick={() => removeCondition(i)}
                        className="hover:text-white"
                        aria-label={`Remove ${c}`}
                      >
                        <X size={11} />
                      </button>
                    </span>
                  );
                })}
              </div>
            )}
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
                placeholder={t('families_edit.medical_add_placeholder')}
                className="flex-1 bg-surface-deep border border-slate-700 rounded-lg px-3 py-2 text-sm focus:border-brand outline-none"
              />
              <select
                value={newSeverity}
                onChange={(e) => setNewSeverity(e.target.value as Severity)}
                aria-label={t('families_edit.severity')}
                className="bg-surface-deep border border-slate-700 rounded-lg px-3 py-2 text-sm focus:border-brand outline-none sm:w-36"
              >
                {MEDICAL_SEVERITY.map((s) => (
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
                <Plus size={12} /> {t('families_edit.medical_add')}
              </button>
            </div>
          </Field>

          {/* Notes */}
          <Field label={t('families_edit.notes')}>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={3}
              placeholder={t('families_edit.notes_placeholder') ?? ''}
              className="w-full bg-surface-deep border border-slate-700 rounded-lg px-3 py-2 text-sm focus:border-brand outline-none"
            />
          </Field>

          {/* Coordinates (optional) */}
          <details className="bg-surface-deep/40 border border-slate-700 rounded-lg px-3 py-2">
            <summary className="text-sm cursor-pointer text-slate-300">
              {t('families_edit.coordinates_optional')}
            </summary>
            <div className="grid sm:grid-cols-2 gap-3 mt-3">
              <Field label="Latitude">
                <input
                  value={latStr}
                  onChange={(e) => setLatStr(e.target.value)}
                  placeholder="e.g. 33.513"
                  className="w-full bg-surface-deep border border-slate-700 rounded-lg px-3 py-2 text-sm focus:border-brand outline-none"
                />
              </Field>
              <Field label="Longitude">
                <input
                  value={lngStr}
                  onChange={(e) => setLngStr(e.target.value)}
                  placeholder="e.g. 36.292"
                  className="w-full bg-surface-deep border border-slate-700 rounded-lg px-3 py-2 text-sm focus:border-brand outline-none"
                />
              </Field>
            </div>
          </details>

          {error && (
            <div className="text-xs px-3 py-2 rounded-lg bg-priority-critical/10 border border-priority-critical/30 text-priority-critical flex items-start gap-2">
              <AlertTriangle size={14} className="flex-shrink-0 mt-0.5" />
              <span>{error}</span>
            </div>
          )}
        </div>

        <footer className="px-5 py-3 border-t border-slate-700 flex justify-between items-center gap-2 bg-surface-deep/50">
          {isEditing && existing ? (
            <button
              onClick={async () => {
                if (
                  !confirm(
                    t('families_edit.confirm_delete', {
                      name: existing.head_name,
                    }) ?? ''
                  )
                )
                  return;
                await db.families.delete(existing.family_id);
                onClose();
              }}
              className="touch-target px-3 py-2 hover:bg-priority-critical/10 hover:text-priority-critical text-slate-500 rounded-lg text-xs flex items-center gap-1"
            >
              <Trash2 size={12} /> {t('families_edit.delete')}
            </button>
          ) : (
            <span />
          )}
          <div className="flex gap-2">
            <button
              onClick={onClose}
              disabled={saving}
              className="touch-target px-4 py-2 bg-surface-light hover:bg-slate-600 disabled:opacity-50 rounded-lg text-sm flex items-center gap-1"
            >
              <X size={14} /> {t('common.cancel')}
            </button>
            <button
              onClick={() => void handleSave()}
              disabled={saving}
              className="touch-target px-4 py-2 bg-brand hover:bg-brand-dark disabled:opacity-50 text-white rounded-lg text-sm font-semibold flex items-center gap-1"
            >
              <Save size={14} />{' '}
              {saving
                ? t('common.saving')
                : isEditing
                ? t('families_edit.save')
                : t('families_edit.create')}
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}

function Field({
  label,
  required,
  children,
}: {
  label: string;
  required?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label className="block text-xs text-slate-400 mb-1.5 font-medium">
        {label}
        {required && <span className="text-priority-critical"> *</span>}
      </label>
      {children}
    </div>
  );
}
