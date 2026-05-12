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

import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  X,
  Save,
  Plus,
  Trash2,
  AlertTriangle,
  UserPlus,
  Edit2,
  FileSpreadsheet,
  SkipForward,
  Sparkles,
  HelpCircle,
  Camera,
} from 'lucide-react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '@/db/database';
import { computeRuleScore } from '@/services/priorityRules';
import { findDuplicateFamily } from '@/services/familyDuplicates';
import {
  parseSpreadsheet,
  proposeColumnMapping,
  coerceRow,
  type ColumnMapping,
  type CoercedRow,
} from '@/services/spreadsheetImport';
import PaperFormImport from '@/components/PaperFormImport';
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
  inline = false,
}: {
  existing?: Family;
  onClose: () => void;
  /**
   * When true, render the form as a regular page section instead of a
   * fixed-position modal overlay. Used by the family detail page so the
   * "Edit profile" experience swaps the read-only cards for the form
   * inline (no popup card-on-top-of-card).
   */
  inline?: boolean;
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

  // ---- Spreadsheet-import wizard state --------------------------------
  // Active only while the admin is walking through rows from a CSV/XLSX.
  // Each Save advances to the next row and refills the form. Skip jumps
  // ahead without saving. Cancel exits wizard mode but leaves whatever's
  // currently in the form so the admin can finish manually if they want.
  const [importQueue, setImportQueue] = useState<CoercedRow[]>([]);
  const [importIndex, setImportIndex] = useState(0);
  const [importMapping, setImportMapping] = useState<ColumnMapping | null>(null);
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // Tooltip popover next to the Import button — explains the recommended
  // column headers so the admin knows how to format their spreadsheet.
  const [tipOpen, setTipOpen] = useState(false);
  // Sibling import path: "Import from photo" opens the multimodal flow
  // on top of this modal. Photo-imported rows commit as fresh families
  // (separate from the form being filled here), so closing the photo
  // modal returns the user to this form unchanged.
  const [photoImportOpen, setPhotoImportOpen] = useState(false);
  useEffect(() => {
    if (!tipOpen) return;
    const close = () => setTipOpen(false);
    document.addEventListener('click', close);
    return () => document.removeEventListener('click', close);
  }, [tipOpen]);

  const inWizard = importQueue.length > 0;
  const currentRowNumber = inWizard ? importIndex + 1 : 0;
  const totalRows = importQueue.length;

  // Push one coerced row's fields into every form setter. This is the
  // bridge between the import service and the existing form. Defaults are
  // applied for fields the row didn't touch so leftover values from a
  // previous row don't bleed in.
  const fillFormFromRow = (row: CoercedRow) => {
    const f = row.family;
    setHeadName(f.head_name ?? '');
    setMemberCount(Math.max(1, f.member_count ?? 1));
    setChildrenUnder5(f.children_under_5 ?? 0);
    setElderlyCount(f.elderly_count ?? 0);
    setHasPregnant(!!f.has_pregnant_member);
    setMedicalConditions(Array.isArray(f.medical_conditions) ? f.medical_conditions : []);
    setDisplacementStatus(f.displacement_status ?? 'resident');
    setIncomeLevel(f.income_level ?? 'minimal');
    setLocationSector(f.location_sector ?? '');
    setStreet(f.street ?? '');
    setCity(f.city ?? '');
    setNotes(f.notes ?? '');
    // Coordinates are not part of the import flow — leave blank.
    setLatStr('');
    setLngStr('');
    // Reset the in-progress condition input so it doesn't carry over.
    setNewCondition('');
    setError(null);
  };

  const startImport = async (file: File) => {
    setImportError(null);
    setImporting(true);
    try {
      const parsed = await parseSpreadsheet(file);
      const mapping = await proposeColumnMapping(parsed.headers, parsed.rows);
      const coerced: CoercedRow[] = parsed.rows.map((r, i) =>
        coerceRow(r, mapping.mapping, i + 1)
      );
      if (coerced.length === 0) {
        setImportError(
          t(
            'import.empty_file',
            'No data rows found in the spreadsheet.'
          )
        );
        return;
      }
      setImportMapping(mapping);
      setImportQueue(coerced);
      setImportIndex(0);
      fillFormFromRow(coerced[0]);
    } catch (e) {
      setImportError(e instanceof Error ? e.message : String(e));
    } finally {
      setImporting(false);
    }
  };

  const advanceImport = () => {
    const nextIdx = importIndex + 1;
    if (nextIdx >= importQueue.length) {
      // Wizard finished — exit cleanly. The modal will close via the
      // existing onClose() flow in handleSave.
      setImportQueue([]);
      setImportIndex(0);
      setImportMapping(null);
      return false;
    }
    setImportIndex(nextIdx);
    fillFormFromRow(importQueue[nextIdx]);
    return true;
  };

  const skipImportRow = () => {
    if (!inWizard) return;
    advanceImport();
  };

  const cancelImport = () => {
    setImportQueue([]);
    setImportIndex(0);
    setImportMapping(null);
    setImportError(null);
  };

  // Pull all existing sector names so the user can pick from what's already
  // in the database (avoids typos / sector fragmentation).
  const allFamilies = useLiveQuery(
    () => db.families.toArray().then((rows) => rows.filter((f) => !f.deleted_at))
  ) ?? [];
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

      // Compute the id ONCE — the previous code generated it twice in the
      // same submit (once inside the `existing ?? { family_id }` literal,
      // once in the explicit override line below). Only the second call
      // won, but timestamp-based ids waste a millisecond and make logs
      // confusing. One call, reused.
      const family_id = existing?.family_id ?? newFamilyId();

      // Duplicate guard — same head-of-household + same member count is
      // treated as a duplicate by every creation path (manual form,
      // spreadsheet wizard, photo ingest). On EDIT we pass `family_id`
      // as excludeId so the family is never flagged against itself.
      // We surface the existing F-ID so the admin knows where to go
      // edit instead of creating a clone.
      const dup = await findDuplicateFamily(
        headName.trim(),
        memberCount,
        existing?.family_id ?? family_id
      );
      if (dup) {
        setError(
          t('families_edit.duplicate_error', {
            name: dup.head_name,
            id: dup.family_id,
            members: dup.member_count,
            defaultValue: `A family "${dup.head_name}" with ${dup.member_count} members already exists (${dup.family_id}). Open that family to edit instead of creating a duplicate.`,
          })
        );
        setSaving(false);
        return;
      }
      // Build the family row preserving cached AI fields when editing.
      const family: Family = {
        ...(existing ?? { family_id }),
        family_id,
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
      //
      // DELIBERATELY skipped: r.recommended_items. The rule engine CAN
      // suggest items from demographics (e.g. children<5 → infant formula)
      // but those suggestions are hints, not facts. Persisting them on a
      // new family (manual create OR spreadsheet wizard) would stamp
      // auto-invented needs that the source never entered. For EDITS the
      // existing family's recommended_items propagates automatically via
      // the `...existing` spread above, so worker-curated lists are
      // preserved without any special handling here. The UI still shows
      // rule-engine suggestions as a soft fallback when the field is
      // unset (see FamilyRow + CurrentNeedsCard), so the helpful hints
      // stay visible without becoming database facts.
      const r = computeRuleScore(family);
      family.priority_score = r.priority_score;
      family.priority_level = r.priority_level;
      family.ai_reason = r.reason;

      await db.families.put(family);
      // In wizard mode, advance to the next row instead of closing — the
      // admin keeps reviewing each imported family in turn. Only the very
      // last row's save closes the modal.
      if (inWizard) {
        const advanced = advanceImport();
        if (!advanced) {
          onClose();
        }
      } else {
        onClose();
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  // When inline === true, render the same form body without the fixed
  // overlay wrapper — it becomes a regular section in the parent page.
  // When false (default), it's the original modal overlay.
  const formBody = (
    <div
      className={
        inline
          ? 'w-full bg-surface border border-brand/40 rounded-xl shadow-lg flex flex-col'
          : 'w-full max-w-2xl bg-surface border border-brand/40 rounded-xl shadow-2xl flex flex-col max-h-[90vh]'
      }
      onClick={inline ? undefined : (e) => e.stopPropagation()}
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

        {/* Import affordances — only on create (no point in replacing fields
            when editing an existing family). Two stacked rows: spreadsheet
            ingest (Gemma 4 maps columns) and paper-form photo ingest
            (Gemma 4 vision reads the rows). Both feed candidate families
            into the registry; this form stays untouched until you save it.
            The wizard banner takes over when the spreadsheet flow is active. */}
        {!isEditing && (
          <div className="px-5 pt-3 space-y-2">
            {!inWizard ? (
              <>
              <div className="flex items-center justify-between gap-3 px-3 py-2 rounded-lg bg-surface-light/50 border border-slate-700">
                <div className="flex items-center gap-2 text-xs text-slate-300">
                  <FileSpreadsheet size={14} className="text-brand" />
                  <span>
                    {t(
                      'import.inline_hint',
                      'Have a spreadsheet of families? Import each row into this form for review.'
                    )}
                  </span>
                </div>
                <div className="flex items-center gap-1.5">
                  {/* Help affordance — click to see the recommended column
                      headers so the admin can format their spreadsheet
                      correctly before importing. */}
                  <div className="relative">
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        setTipOpen((v) => !v);
                      }}
                      title={t(
                        'import.tip_button_title',
                        'Show recommended column headers'
                      )}
                      aria-label={t(
                        'import.tip_button_title',
                        'Show recommended column headers'
                      )}
                      aria-expanded={tipOpen}
                      className="touch-target p-1.5 hover:bg-brand/10 hover:text-brand text-slate-400 rounded-lg"
                    >
                      <HelpCircle size={14} />
                    </button>
                    {tipOpen && (
                      <div
                        onClick={(e) => e.stopPropagation()}
                        role="tooltip"
                        className="absolute end-0 top-full mt-1 z-30 w-[340px] max-w-[calc(100vw-2rem)] bg-surface border border-slate-700 rounded-lg shadow-xl p-3 text-xs text-slate-200"
                      >
                        <div className="flex items-center justify-between mb-2">
                          <div className="font-semibold text-brand text-[11px] uppercase tracking-wider">
                            {t('import.tip_title', 'Recommended column headers')}
                          </div>
                          <button
                            type="button"
                            onClick={() => setTipOpen(false)}
                            className="touch-target p-1 hover:bg-surface-light rounded text-slate-400 hover:text-slate-200"
                            aria-label={t('common.close', 'Close')}
                          >
                            <X size={12} />
                          </button>
                        </div>
                        <table className="w-full">
                          <thead>
                            <tr className="text-[10px] text-slate-500 uppercase tracking-wider">
                              <th className="text-start font-medium pb-1">
                                {t('import.tip_col_header', 'Header')}
                              </th>
                              <th className="text-start font-medium pb-1 ps-2">
                                {t('import.tip_col_format', 'Expected value')}
                              </th>
                            </tr>
                          </thead>
                          <tbody className="space-y-0.5">
                            <tr>
                              <td className="font-medium text-slate-100 py-0.5">Head of Household</td>
                              <td className="text-slate-400 ps-2 py-0.5">
                                {t('import.tip_required', 'required, free text')}
                              </td>
                            </tr>
                            <tr>
                              <td className="font-medium text-slate-100 py-0.5">Sector</td>
                              <td className="text-slate-400 ps-2 py-0.5">
                                {t('import.tip_sector', 'camp / area / district')}
                              </td>
                            </tr>
                            <tr>
                              <td className="font-medium text-slate-100 py-0.5">Total Members</td>
                              <td className="text-slate-400 ps-2 py-0.5">
                                {t('import.tip_int_ge_1', 'integer ≥ 1')}
                              </td>
                            </tr>
                            <tr>
                              <td className="font-medium text-slate-100 py-0.5">Children under 5</td>
                              <td className="text-slate-400 ps-2 py-0.5">
                                {t('import.tip_int_ge_0', 'integer ≥ 0')}
                              </td>
                            </tr>
                            <tr>
                              <td className="font-medium text-slate-100 py-0.5">Elderly (65+)</td>
                              <td className="text-slate-400 ps-2 py-0.5">
                                {t('import.tip_int_ge_0', 'integer ≥ 0')}
                              </td>
                            </tr>
                            <tr>
                              <td className="font-medium text-slate-100 py-0.5">Pregnant Member</td>
                              <td className="text-slate-400 ps-2 py-0.5">
                                {t('import.tip_yesno', 'Yes / No')}
                              </td>
                            </tr>
                            <tr>
                              <td className="font-medium text-slate-100 py-0.5">Displacement Status</td>
                              <td className="text-slate-400 ps-2 py-0.5">
                                resident · recently_displaced · refugee
                              </td>
                            </tr>
                            <tr>
                              <td className="font-medium text-slate-100 py-0.5">Income Level</td>
                              <td className="text-slate-400 ps-2 py-0.5">
                                none · minimal · moderate
                              </td>
                            </tr>
                            <tr>
                              <td className="font-medium text-slate-100 py-0.5">Medical Conditions</td>
                              <td className="text-slate-400 ps-2 py-0.5">
                                {t('import.tip_csv_list', 'comma-separated list')}
                              </td>
                            </tr>
                            <tr>
                              <td className="font-medium text-slate-100 py-0.5">Street</td>
                              <td className="text-slate-400 ps-2 py-0.5">
                                {t('import.tip_optional', 'optional')}
                              </td>
                            </tr>
                            <tr>
                              <td className="font-medium text-slate-100 py-0.5">City</td>
                              <td className="text-slate-400 ps-2 py-0.5">
                                {t('import.tip_optional', 'optional')}
                              </td>
                            </tr>
                            <tr>
                              <td className="font-medium text-slate-100 py-0.5">Notes</td>
                              <td className="text-slate-400 ps-2 py-0.5">
                                {t('import.tip_optional', 'optional, free text')}
                              </td>
                            </tr>
                          </tbody>
                        </table>
                        <div className="mt-2 pt-2 border-t border-slate-700 text-[11px] text-slate-400 leading-relaxed">
                          {t(
                            'import.tip_synonyms',
                            'Headers don\'t need to match exactly — synonyms work (e.g. "HoH", "Household Head", "IDP" → recently_displaced).'
                          )}{' '}
                          <span className="text-slate-300">
                            {t(
                              'import.tip_unmapped',
                              'Unmapped columns are saved into Notes.'
                            )}
                          </span>
                        </div>
                        <div className="mt-1 text-[10px] text-slate-500 italic">
                          {t(
                            'import.tip_id_note',
                            'Family IDs are generated automatically — do not include them.'
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      if (fileInputRef.current) fileInputRef.current.value = '';
                      fileInputRef.current?.click();
                    }}
                    disabled={importing}
                    className="touch-target px-2.5 py-1.5 bg-brand/10 hover:bg-brand/20 disabled:opacity-50 text-brand border border-brand/30 rounded-lg text-xs font-semibold flex items-center gap-1.5"
                  >
                    <FileSpreadsheet size={12} />
                    {importing
                      ? t('import.parsing_short', 'Reading…')
                      : t('import.button_label', 'Import')}
                  </button>
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept=".csv,.xlsx,.xls,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                    className="hidden"
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      if (f) void startImport(f);
                      e.target.value = '';
                    }}
                  />
                </div>
              </div>
              {/* Sibling row — paper-form photo ingest. Mirrors the spreadsheet
                  banner above but routes through Gemma 4 vision. */}
              <div className="flex items-center justify-between gap-3 px-3 py-2 rounded-lg bg-surface-light/50 border border-slate-700">
                <div className="flex items-center gap-2 text-xs text-slate-300">
                  <Camera size={14} className="text-ai" />
                  <span>
                    {t(
                      'paper_form.inline_hint',
                      'Have a paper form? Snap a photo and the local AI reads each row.'
                    )}
                  </span>
                </div>
                <button
                  type="button"
                  onClick={() => setPhotoImportOpen(true)}
                  className="touch-target px-2.5 py-1.5 bg-ai/10 hover:bg-ai/20 text-ai border border-ai/30 rounded-lg text-xs font-semibold flex items-center gap-1.5"
                  title={
                    t(
                      'paper_form.button_tip',
                      'Snap a photo of a paper registration form. The local AI reads each row offline.'
                    ) ?? undefined
                  }
                >
                  <Camera size={12} />
                  {t('paper_form.button', 'Import from photo')}
                </button>
              </div>
              </>
            ) : (
              <div className="px-3 py-2 rounded-lg bg-brand/10 border border-brand/30 flex items-center justify-between gap-3 flex-wrap">
                <div className="flex items-center gap-2 text-xs text-brand font-semibold flex-wrap">
                  <FileSpreadsheet size={14} />
                  <span>
                    {t('import.wizard_progress', 'Importing row {{n}} of {{total}}', {
                      n: currentRowNumber,
                      total: totalRows,
                    })}
                  </span>
                  {importMapping?.source === 'ai' && (
                    <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-ai/20 text-ai inline-flex items-center gap-1">
                      <Sparkles size={9} />
                      {t('import.ai_badge', 'AI-mapped')}
                    </span>
                  )}
                  {importMapping?.source === 'heuristic' && (
                    <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-priority-medium/20 text-priority-medium inline-flex items-center gap-1">
                      <AlertTriangle size={9} />
                      {t('import.heuristic_badge', 'Heuristic mapping (Ollama offline)')}
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={skipImportRow}
                    disabled={saving}
                    className="touch-target px-2.5 py-1.5 bg-surface-light hover:bg-slate-600 disabled:opacity-50 text-slate-200 border border-slate-700 rounded-lg text-xs font-semibold flex items-center gap-1"
                    title={t(
                      'import.skip_row_tooltip',
                      'Discard this row and move to the next'
                    )}
                  >
                    <SkipForward size={11} />
                    {t('import.skip_row', 'Skip')}
                  </button>
                  <button
                    type="button"
                    onClick={cancelImport}
                    disabled={saving}
                    className="touch-target px-2.5 py-1.5 hover:bg-priority-critical/10 hover:text-priority-critical disabled:opacity-50 text-slate-400 rounded-lg text-xs font-semibold flex items-center gap-1"
                    title={t(
                      'import.cancel_tooltip',
                      'Stop the import — remaining rows are discarded'
                    )}
                  >
                    <X size={11} />
                    {t('import.cancel_import', 'Cancel import')}
                  </button>
                </div>
              </div>
            )}
            {importError && (
              <div className="mt-2 px-3 py-2 rounded-lg bg-priority-critical/10 border border-priority-critical/30 text-priority-critical text-xs flex items-start gap-2">
                <AlertTriangle size={12} className="mt-0.5 flex-shrink-0" />
                <span>{importError}</span>
              </div>
            )}
            {/* Per-row warnings from the coercion step (e.g. "income value
                fell back to default") — not blocking, but worth showing. */}
            {inWizard && importQueue[importIndex]?.warnings.length > 0 && (
              <div className="mt-2 px-3 py-2 rounded-lg bg-priority-medium/10 border border-priority-medium/30 text-priority-medium text-[11px] flex items-start gap-2">
                <AlertTriangle size={11} className="mt-0.5 flex-shrink-0" />
                <ul className="space-y-0.5 flex-1">
                  {importQueue[importIndex].warnings.map((w, i) => (
                    <li key={i}>{w}</li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}

        <div className="px-5 py-4 space-y-4 overflow-y-auto">
          {/* Error banner — pinned at the top of the form body so a
              duplicate warning (or any other save-blocking validation
              error) is visible the moment the admin lands on the modal,
              without having to scroll past every field first. */}
          {error && (
            <div
              role="alert"
              className="text-xs px-3 py-2 rounded-lg bg-priority-critical/10 border border-priority-critical/30 text-priority-critical flex items-start gap-2"
            >
              <AlertTriangle size={14} className="flex-shrink-0 mt-0.5" />
              <span>{error}</span>
            </div>
          )}

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
                    {/* Localized labels for closed-set enum values; falls
                        back to the humanized enum when no translation. */}
                    {t(`families_edit.displacement_${opt}`) ?? opt.replace('_', ' ')}
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
                    {t(`families_edit.income_${opt}`) ?? opt}
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
                // Soft-delete: tag the row with deleted_at so historic
                // AidDistribution.family_id references stay coherent
                // (audit trail, history grid, monthly reports). Same
                // pattern as Workers. Live queries everywhere already
                // filter out !!deleted_at.
                await db.families.update(existing.family_id, {
                  deleted_at: new Date().toISOString(),
                });
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
                : inWizard
                ? importIndex < importQueue.length - 1
                  ? t('import.save_and_next', 'Save & next')
                  : t('import.save_and_finish', 'Save & finish')
                : isEditing
                ? t('families_edit.save')
                : t('families_edit.create')}
            </button>
          </div>
        </footer>
      </div>
  );

  // Inline mode: render the form body directly. Modal mode: wrap in a
  // fixed-position overlay so it appears as a centered dialog. Either way,
  // the photo-import modal can stack on top when triggered.
  if (inline) {
    return (
      <>
        {formBody}
        {photoImportOpen && (
          <PaperFormImport onClose={() => setPhotoImportOpen(false)} />
        )}
      </>
    );
  }
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
        className="w-full max-w-2xl max-h-[90vh] overflow-hidden flex flex-col"
      >
        {formBody}
      </div>
      {/* Photo-import flow stacks above this modal. Closing it returns
          control to the form below — nothing about the form's draft
          state is touched. */}
      {photoImportOpen && (
        <PaperFormImport onClose={() => setPhotoImportOpen(false)} />
      )}
    </div>
  );
}

// Local Field helper — matches the shape used by EditableDemographicsCard
// so the inline labels render consistently. Defined inline (not imported)
// because this file already has a heavy import block and we don't want a
// shared component spanning multiple files for what's effectively
// presentation glue.
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
