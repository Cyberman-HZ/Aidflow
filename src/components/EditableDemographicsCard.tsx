// Demographics card with inline edit: read-only by default, click the pencil
// icon and the body expands into a form for ALL demographic fields. Saves
// only that slice of the family record (head name, location, address,
// member counts, pregnancy flag, displacement, income), then recomputes
// the rule-based priority so the badge stays in sync.

import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Edit2, Save, X, MapPin, Users, Baby, Heart } from 'lucide-react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '@/db/database';
import { computeRuleScore } from '@/services/priorityRules';
import { Card } from '@/components/Card';
import type { Family, DisplacementStatus, IncomeLevel } from '@/types';

const DISPLACEMENT_OPTIONS: DisplacementStatus[] = [
  'resident',
  'recently_displaced',
  'refugee',
];
const INCOME_OPTIONS: IncomeLevel[] = ['none', 'minimal', 'moderate'];

export default function EditableDemographicsCard({ family }: { family: Family }) {
  const { t } = useTranslation();
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Local draft state; only reads from `family` when entering edit mode.
  const [headName, setHeadName] = useState(family.head_name);
  const [memberCount, setMemberCount] = useState(family.member_count);
  const [children, setChildren] = useState(family.children_under_5);
  const [elderly, setElderly] = useState(family.elderly_count);
  const [pregnant, setPregnant] = useState(family.has_pregnant_member);
  const [displacement, setDisplacement] = useState<DisplacementStatus>(
    family.displacement_status
  );
  const [income, setIncome] = useState<IncomeLevel>(family.income_level);
  const [sector, setSector] = useState(family.location_sector);
  const [street, setStreet] = useState(family.street ?? '');
  const [city, setCity] = useState(family.city ?? '');

  // Excludes soft-deleted families from address-suggestion neighbours.
  const allFamilies = useLiveQuery(
    () => db.families.toArray().then((rows) => rows.filter((f) => !f.deleted_at))
  ) ?? [];
  const sectors = useMemo(
    () =>
      Array.from(
        new Set(
          allFamilies
            .map((f) => f.location_sector?.trim())
            .filter((s): s is string => !!s)
        )
      ).sort(),
    [allFamilies]
  );

  const startEdit = () => {
    setHeadName(family.head_name);
    setMemberCount(family.member_count);
    setChildren(family.children_under_5);
    setElderly(family.elderly_count);
    setPregnant(family.has_pregnant_member);
    setDisplacement(family.displacement_status);
    setIncome(family.income_level);
    setSector(family.location_sector);
    setStreet(family.street ?? '');
    setCity(family.city ?? '');
    setError(null);
    setEditing(true);
  };

  const validate = (): string | null => {
    if (!headName.trim()) return 'Head of household name is required.';
    if (!sector.trim()) return 'Location sector is required.';
    if (memberCount < 1) return 'Member count must be at least 1.';
    if (children < 0 || elderly < 0) return 'Counts cannot be negative.';
    if (children + elderly > memberCount)
      return 'Children + elderly cannot exceed total members.';
    return null;
  };

  const save = async () => {
    const e = validate();
    if (e) {
      setError(e);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const next: Family = {
        ...family,
        head_name: headName.trim(),
        member_count: Math.max(1, Math.floor(memberCount)),
        children_under_5: Math.max(0, Math.floor(children)),
        elderly_count: Math.max(0, Math.floor(elderly)),
        has_pregnant_member: pregnant,
        displacement_status: displacement,
        income_level: income,
        location_sector: sector.trim(),
        street: street.trim() || undefined,
        city: city.trim() || undefined,
        last_updated: new Date().toISOString(),
      };
      // Recompute rule-based priority so the badge updates immediately.
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
        <div className="flex items-center gap-2">{t('family_detail.demographics')}</div>
      }
      action={
        editing ? null : (
          <button
            onClick={startEdit}
            className="touch-target px-2.5 py-1 hover:bg-surface-light text-slate-300 hover:text-brand rounded-md text-xs flex items-center gap-1"
            aria-label="Edit demographics"
          >
            <Edit2 size={12} /> {t('family_detail.edit')}
          </button>
        )
      }
      className="lg:col-span-1"
    >
      {!editing ? (
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
      ) : (
        <div className="space-y-3 text-sm">
          <Field label={t('families_edit.head_name')} required>
            <input
              value={headName}
              onChange={(e) => setHeadName(e.target.value)}
              className="w-full bg-surface-deep border border-slate-700 rounded-lg px-3 py-2 text-sm focus:border-brand outline-none"
            />
          </Field>
          <Field label={t('families_edit.sector') ?? 'Location sector'} required>
            <select
              value={sector}
              onChange={(e) => setSector(e.target.value)}
              className="w-full bg-surface-deep border border-slate-700 rounded-lg px-3 py-2 text-sm focus:border-brand outline-none"
            >
              {/* Closed-set picker. The current value is always selectable
                  (even if it's somehow not in the live sectors list — e.g.
                  the family was created with a now-removed sector). */}
              {sectors.length === 0 && sector === '' && (
                <option value="" disabled>
                  — no sectors defined —
                </option>
              )}
              {sector && !sectors.includes(sector) && (
                <option value={sector}>{sector}</option>
              )}
              {sectors.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </Field>
          <div className="grid grid-cols-2 gap-2">
            <Field label={t('families_edit.street')}>
              <input
                value={street}
                onChange={(e) => setStreet(e.target.value)}
                placeholder="e.g. 12 Olive Tree Lane"
                className="w-full bg-surface-deep border border-slate-700 rounded-lg px-3 py-2 text-xs focus:border-brand outline-none"
              />
            </Field>
            <Field label={t('families_edit.city')}>
              <input
                value={city}
                onChange={(e) => setCity(e.target.value)}
                placeholder="e.g. Damascus"
                className="w-full bg-surface-deep border border-slate-700 rounded-lg px-3 py-2 text-xs focus:border-brand outline-none"
              />
            </Field>
          </div>
          <div className="grid grid-cols-3 gap-2">
            <Field label={t('families.members')} required>
              <input
                type="number"
                min={1}
                value={memberCount}
                onChange={(e) => setMemberCount(Math.max(1, +e.target.value || 1))}
                className="w-full bg-surface-deep border border-slate-700 rounded-lg px-2 py-2 text-sm text-center focus:border-brand outline-none"
              />
            </Field>
            <Field label={t('families.children_under5')}>
              <input
                type="number"
                min={0}
                value={children}
                onChange={(e) => setChildren(Math.max(0, +e.target.value || 0))}
                className="w-full bg-surface-deep border border-slate-700 rounded-lg px-2 py-2 text-sm text-center focus:border-brand outline-none"
              />
            </Field>
            <Field label={t('families.elderly')}>
              <input
                type="number"
                min={0}
                value={elderly}
                onChange={(e) => setElderly(Math.max(0, +e.target.value || 0))}
                className="w-full bg-surface-deep border border-slate-700 rounded-lg px-2 py-2 text-sm text-center focus:border-brand outline-none"
              />
            </Field>
          </div>
          <label className="flex items-center gap-2 cursor-pointer bg-surface-deep border border-slate-700 rounded-lg px-3 py-2">
            <input
              type="checkbox"
              checked={pregnant}
              onChange={(e) => setPregnant(e.target.checked)}
              className="accent-brand"
            />
            <span className="text-sm">{t('families_edit.pregnant_label')}</span>
          </label>
          <div className="grid grid-cols-2 gap-2">
            <Field label={t('family_detail.displacement')}>
              <select
                value={displacement}
                onChange={(e) => setDisplacement(e.target.value as DisplacementStatus)}
                className="w-full bg-surface-deep border border-slate-700 rounded-lg px-2 py-2 text-sm focus:border-brand outline-none capitalize"
              >
                {DISPLACEMENT_OPTIONS.map((d) => (
                  <option key={d} value={d}>
                    {d.replace('_', ' ')}
                  </option>
                ))}
              </select>
            </Field>
            <Field label={t('family_detail.income')}>
              <select
                value={income}
                onChange={(e) => setIncome(e.target.value as IncomeLevel)}
                className="w-full bg-surface-deep border border-slate-700 rounded-lg px-2 py-2 text-sm focus:border-brand outline-none capitalize"
              >
                {INCOME_OPTIONS.map((d) => (
                  <option key={d} value={d}>
                    {d}
                  </option>
                ))}
              </select>
            </Field>
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
      <label className="block text-[11px] text-slate-400 mb-1 font-medium">
        {label}
        {required && <span className="text-priority-critical"> *</span>}
      </label>
      {children}
    </div>
  );
}
