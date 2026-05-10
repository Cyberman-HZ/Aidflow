// SpreadsheetImportModal — three-step CSV/XLSX import wizard.
// Step 1: pick a file. Step 2: review the AI-proposed column mapping.
// Step 3: review per-row proposals + import. Same a11y plumbing as the
// other in-app modals (Escape closes when not busy, body scroll lock,
// focus on the primary action on mount).

import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  X as XIcon,
  Upload,
  FileSpreadsheet,
  AlertTriangle,
  CheckCircle2,
  Sparkles,
  ChevronLeft,
  ChevronRight,
  Loader2,
} from 'lucide-react';
import {
  parseSpreadsheet,
  proposeColumnMapping,
  coerceRow,
  commitImport,
  IMPORTABLE_FIELDS,
  type ParsedSpreadsheet,
  type ColumnMapping,
  type CoercedRow,
  type ImportableFamilyField,
  type ImportResult,
} from '@/services/spreadsheetImport';

type Step = 'upload' | 'mapping' | 'review' | 'done';

const FIELD_LABELS: Record<ImportableFamilyField, string> = {
  head_name: 'Head of household',
  member_count: 'Total members',
  children_under_5: 'Children under 5',
  elderly_count: 'Elderly (65+)',
  has_pregnant_member: 'Pregnant member?',
  medical_conditions: 'Medical conditions',
  displacement_status: 'Displacement status',
  income_level: 'Income level',
  location_sector: 'Sector',
  street: 'Street',
  city: 'City',
  notes: 'Notes',
};

export default function SpreadsheetImportModal({
  onClose,
}: {
  onClose: (importedCount?: number) => void;
}) {
  const { t } = useTranslation();
  const [step, setStep] = useState<Step>('upload');

  // Step 1 — upload
  const [file, setFile] = useState<File | null>(null);
  const [parsing, setParsing] = useState(false);
  const [parseError, setParseError] = useState<string | null>(null);
  const [parsed, setParsed] = useState<ParsedSpreadsheet | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  // Step 2 — mapping
  const [mappingProposing, setMappingProposing] = useState(false);
  const [mapping, setMapping] = useState<ColumnMapping | null>(null);

  // Step 3 — review
  const [coercedRows, setCoercedRows] = useState<CoercedRow[]>([]);
  // Default selection: every row that doesn't have validation errors.
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState<ImportResult | null>(null);

  const primaryRef = useRef<HTMLButtonElement | null>(null);

  // ---- Modal a11y plumbing ---------------------------------------------
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      // Don't close mid-operation — interrupting a Dexie transaction is bad.
      if (parsing || mappingProposing || importing) return;
      e.preventDefault();
      onClose();
    };
    document.addEventListener('keydown', onKey);
    primaryRef.current?.focus();
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [onClose, parsing, mappingProposing, importing, step]);

  // ---- Step 1: parse the file ------------------------------------------
  const onPick = async (f: File) => {
    setParseError(null);
    setFile(f);
    setParsing(true);
    try {
      const result = await parseSpreadsheet(f);
      setParsed(result);
      // Kick off mapping immediately — users save a click.
      setStep('mapping');
      setMappingProposing(true);
      try {
        const m = await proposeColumnMapping(result.headers, result.rows);
        setMapping(m);
      } finally {
        setMappingProposing(false);
      }
    } catch (e) {
      setParseError(e instanceof Error ? e.message : String(e));
      setFile(null);
      setParsed(null);
    } finally {
      setParsing(false);
    }
  };

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    const f = e.dataTransfer.files?.[0];
    if (f) void onPick(f);
  };

  // ---- Step 2 → 3: apply the mapping to all rows -----------------------
  const goToReview = () => {
    if (!parsed || !mapping) return;
    const rows: CoercedRow[] = parsed.rows.map((r, i) =>
      coerceRow(r, mapping.mapping, i + 1)
    );
    setCoercedRows(rows);
    // Pre-check valid rows; leave invalid ones unchecked so the user can
    // fix or knowingly skip them.
    const initial = new Set<number>();
    rows.forEach((r) => {
      if (Object.keys(r.errors).length === 0) initial.add(r.rowIndex);
    });
    setSelected(initial);
    setStep('review');
  };

  // ---- Step 3: commit --------------------------------------------------
  const doImport = async () => {
    if (importing) return;
    const toCommit = coercedRows.filter((r) => selected.has(r.rowIndex));
    setImporting(true);
    try {
      const result = await commitImport(toCommit);
      setImportResult(result);
      setStep('done');
    } catch (e) {
      setImportResult({
        imported: 0,
        skipped: toCommit.length,
        errors: [
          {
            rowIndex: 0,
            message:
              e instanceof Error
                ? e.message
                : 'Unknown error while saving to the local database.',
          },
        ],
      });
      setStep('done');
    } finally {
      setImporting(false);
    }
  };

  // ---- Mapping editor --------------------------------------------------
  // For the dropdown value: "" represents "skip / send to notes" (null in
  // the underlying mapping).
  const updateColumn = (col: string, value: string) => {
    if (!mapping) return;
    const next = { ...mapping.mapping };
    const newField =
      value === '' ? null : (value as ImportableFamilyField);
    if (newField) {
      // Enforce uniqueness — clear any other column claiming this field.
      for (const [c, f] of Object.entries(next)) {
        if (c !== col && f === newField) next[c] = null;
      }
    }
    next[col] = newField;
    setMapping({ ...mapping, mapping: next });
  };

  // Sample preview for a column (first non-empty value).
  const samplePreview = useMemo(() => {
    const out: Record<string, string> = {};
    if (!parsed) return out;
    for (const h of parsed.headers) {
      const sample = parsed.rows
        .map((r) => r[h])
        .find((v) => v && v.trim().length > 0);
      out[h] = (sample ?? '').slice(0, 80);
    }
    return out;
  }, [parsed]);

  // ---- Render ----------------------------------------------------------
  return (
    <div
      className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="ssi-title"
      onClick={() => {
        if (parsing || mappingProposing || importing) return;
        onClose(importResult?.imported);
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-4xl max-h-[90vh] bg-surface border border-slate-700 rounded-xl shadow-2xl flex flex-col overflow-hidden"
      >
        <header className="px-5 py-3 border-b border-slate-700 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <FileSpreadsheet size={18} className="text-brand" />
            <h2 id="ssi-title" className="font-semibold">
              {t('import.title', 'Import families from spreadsheet')}
            </h2>
            <StepBadge step={step} />
          </div>
          <button
            onClick={() => {
              if (parsing || mappingProposing || importing) return;
              onClose(importResult?.imported);
            }}
            className="touch-target p-1.5 hover:bg-surface-light text-slate-400 hover:text-slate-200 rounded"
            aria-label={t('common.close', 'Close')}
            disabled={parsing || mappingProposing || importing}
          >
            <XIcon size={16} />
          </button>
        </header>

        <div className="flex-1 overflow-y-auto p-5 space-y-4">
          {step === 'upload' && (
            <UploadStep
              parsing={parsing}
              parseError={parseError}
              onDrop={onDrop}
              onPick={onPick}
              fileInput={fileInput}
              file={file}
              t={t}
            />
          )}

          {step === 'mapping' && parsed && (
            <MappingStep
              parsed={parsed}
              mapping={mapping}
              proposing={mappingProposing}
              samplePreview={samplePreview}
              updateColumn={updateColumn}
              t={t}
            />
          )}

          {step === 'review' && (
            <ReviewStep
              rows={coercedRows}
              selected={selected}
              setSelected={setSelected}
              t={t}
            />
          )}

          {step === 'done' && importResult && (
            <DoneStep result={importResult} t={t} />
          )}
        </div>

        <footer className="px-5 py-3 border-t border-slate-700 flex items-center justify-between gap-3 bg-surface-light/30">
          <div className="text-xs text-slate-400">
            {step === 'upload' &&
              t('import.upload_hint', 'CSV or XLSX. The first row must be column names.')}
            {step === 'mapping' &&
              parsed &&
              t('import.mapping_hint', '{{n}} columns detected. Adjust the mapping if needed.', {
                n: parsed.headers.length,
              })}
            {step === 'review' &&
              t('import.review_hint', '{{checked}} of {{total}} rows selected for import.', {
                checked: selected.size,
                total: coercedRows.length,
              })}
            {step === 'done' && t('import.done_hint', 'Import complete.')}
          </div>
          <div className="flex items-center gap-2">
            {step === 'mapping' && (
              <>
                <button
                  onClick={() => setStep('upload')}
                  disabled={mappingProposing}
                  className="touch-target px-3 py-1.5 bg-surface-light hover:bg-slate-600 text-slate-200 rounded-lg text-xs font-semibold flex items-center gap-1 disabled:opacity-50"
                >
                  <ChevronLeft size={12} />
                  {t('common.back', 'Back')}
                </button>
                <button
                  ref={primaryRef}
                  onClick={goToReview}
                  disabled={mappingProposing || !mapping}
                  className="touch-target px-3 py-1.5 bg-brand hover:bg-brand-dark disabled:opacity-50 text-white rounded-lg text-xs font-semibold flex items-center gap-1"
                >
                  {t('common.next', 'Next')}
                  <ChevronRight size={12} />
                </button>
              </>
            )}
            {step === 'review' && (
              <>
                <button
                  onClick={() => setStep('mapping')}
                  disabled={importing}
                  className="touch-target px-3 py-1.5 bg-surface-light hover:bg-slate-600 text-slate-200 rounded-lg text-xs font-semibold flex items-center gap-1 disabled:opacity-50"
                >
                  <ChevronLeft size={12} />
                  {t('common.back', 'Back')}
                </button>
                <button
                  ref={primaryRef}
                  onClick={() => void doImport()}
                  disabled={importing || selected.size === 0}
                  className="touch-target px-3 py-1.5 bg-brand hover:bg-brand-dark disabled:opacity-50 disabled:cursor-not-allowed text-white rounded-lg text-xs font-semibold flex items-center gap-2"
                >
                  {importing ? (
                    <Loader2 size={12} className="animate-spin" />
                  ) : (
                    <Upload size={12} />
                  )}
                  {importing
                    ? t('import.importing', 'Importing…')
                    : t('import.import_n', 'Import {{n}} families', { n: selected.size })}
                </button>
              </>
            )}
            {step === 'done' && (
              <button
                ref={primaryRef}
                onClick={() => onClose(importResult?.imported)}
                className="touch-target px-3 py-1.5 bg-brand hover:bg-brand-dark text-white rounded-lg text-xs font-semibold flex items-center gap-1"
              >
                {t('common.done', 'Done')}
              </button>
            )}
          </div>
        </footer>
      </div>
    </div>
  );
}

// ---------- Step components ----------------------------------------------

function StepBadge({ step }: { step: Step }) {
  const labels: Record<Step, string> = {
    upload: '1 / 3',
    mapping: '2 / 3',
    review: '3 / 3',
    done: '✓',
  };
  return (
    <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-surface-light text-slate-300 font-mono">
      {labels[step]}
    </span>
  );
}

function UploadStep({
  parsing,
  parseError,
  onDrop,
  onPick,
  fileInput,
  file,
  t,
}: {
  parsing: boolean;
  parseError: string | null;
  onDrop: (e: React.DragEvent) => void;
  onPick: (f: File) => void;
  fileInput: React.RefObject<HTMLInputElement | null>;
  file: File | null;
  t: (k: string, ...args: unknown[]) => string;
}) {
  return (
    <div className="space-y-4">
      <div
        onDragOver={(e) => e.preventDefault()}
        onDrop={onDrop}
        onClick={() => {
          if (fileInput.current) fileInput.current.value = '';
          fileInput.current?.click();
        }}
        className="border-2 border-dashed border-slate-700 rounded-xl p-10 text-center cursor-pointer hover:border-brand/50 hover:bg-brand/5 transition-colors"
      >
        <Upload size={32} className="mx-auto text-slate-500 mb-2" />
        <div className="text-sm text-slate-200 font-medium">
          {t('import.drop_here', 'Drop a CSV or XLSX file here, or click to choose')}
        </div>
        <div className="text-xs text-slate-500 mt-1">
          {t('import.formats_supported', 'Supported: .csv, .xlsx, .xls — first row must be headers')}
        </div>
        <input
          ref={fileInput}
          type="file"
          accept=".csv,.xlsx,.xls,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) onPick(f);
            e.target.value = '';
          }}
        />
      </div>
      {parsing && (
        <div className="text-xs text-ai italic flex items-center gap-2">
          <Loader2 size={12} className="animate-spin" />
          {t('import.parsing', 'Reading {{name}}…', { name: file?.name ?? '' })}
        </div>
      )}
      {parseError && (
        <div className="text-xs text-priority-critical bg-priority-critical/10 border border-priority-critical/30 rounded-lg px-3 py-2 flex items-start gap-2">
          <AlertTriangle size={12} className="mt-0.5 flex-shrink-0" />
          <span>{parseError}</span>
        </div>
      )}
    </div>
  );
}

function MappingStep({
  parsed,
  mapping,
  proposing,
  samplePreview,
  updateColumn,
  t,
}: {
  parsed: ParsedSpreadsheet;
  mapping: ColumnMapping | null;
  proposing: boolean;
  samplePreview: Record<string, string>;
  updateColumn: (col: string, value: string) => void;
  t: (k: string, ...args: unknown[]) => string;
}) {
  if (proposing || !mapping) {
    return (
      <div className="text-xs text-ai italic flex items-center gap-2 py-8 justify-center">
        <Sparkles size={14} className="animate-pulse" />
        {t('import.proposing', 'Asking Gemma 4 to propose a column mapping…')}
      </div>
    );
  }
  const isHeuristic = mapping.source === 'heuristic';
  return (
    <div className="space-y-3">
      <div className="text-xs text-slate-400 flex items-center gap-2">
        <FileSpreadsheet size={12} className="text-brand" />
        <span>
          {t('import.detected_summary', '{{format}} · {{cols}} columns · {{rows}} rows', {
            format: parsed.format.toUpperCase(),
            cols: parsed.headers.length,
            rows: parsed.rowCount,
          })}
        </span>
        {isHeuristic && (
          <span className="ms-auto text-[10px] px-1.5 py-0.5 rounded-full bg-priority-medium/15 text-priority-medium font-semibold inline-flex items-center gap-1">
            <AlertTriangle size={10} />
            {t('import.heuristic_badge', 'Heuristic mapping (Ollama offline)')}
          </span>
        )}
        {!isHeuristic && (
          <span className="ms-auto text-[10px] px-1.5 py-0.5 rounded-full bg-ai/15 text-ai font-semibold inline-flex items-center gap-1">
            <Sparkles size={10} />
            {t('import.ai_badge', 'Mapped by Gemma 4')}
          </span>
        )}
      </div>
      <div className="border border-slate-700 rounded-lg overflow-hidden">
        <table className="w-full text-xs">
          <thead className="bg-surface-light text-slate-300">
            <tr>
              <th className="text-start px-3 py-2 font-semibold">
                {t('import.col_spreadsheet', 'Spreadsheet column')}
              </th>
              <th className="text-start px-3 py-2 font-semibold">
                {t('import.col_sample', 'Sample value')}
              </th>
              <th className="text-start px-3 py-2 font-semibold">
                {t('import.col_target', 'Target field')}
              </th>
            </tr>
          </thead>
          <tbody>
            {parsed.headers.map((h) => {
              const targetField = mapping.mapping[h];
              const reason = mapping.reasoning[h];
              return (
                <tr
                  key={h}
                  className="border-t border-slate-700 hover:bg-surface-light/30"
                >
                  <td className="px-3 py-2 align-top">
                    <div className="font-medium text-slate-100">{h}</div>
                    {reason && (
                      <div className="text-[10px] text-slate-500 italic mt-0.5">{reason}</div>
                    )}
                  </td>
                  <td className="px-3 py-2 align-top text-slate-400 max-w-[220px] truncate">
                    {samplePreview[h] || (
                      <span className="italic text-slate-600">
                        {t('import.no_sample', '(no sample)')}
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2 align-top">
                    <select
                      value={targetField ?? ''}
                      onChange={(e) => updateColumn(h, e.target.value)}
                      className="bg-surface-deep border border-slate-700 rounded px-2 py-1 text-xs focus:border-brand outline-none w-full max-w-[200px]"
                    >
                      <option value="">
                        {t('import.send_to_notes', '— Send to notes / skip —')}
                      </option>
                      {IMPORTABLE_FIELDS.map((f) => (
                        <option key={f} value={f}>
                          {FIELD_LABELS[f]}
                        </option>
                      ))}
                    </select>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function ReviewStep({
  rows,
  selected,
  setSelected,
  t,
}: {
  rows: CoercedRow[];
  selected: Set<number>;
  setSelected: (s: Set<number>) => void;
  t: (k: string, ...args: unknown[]) => string;
}) {
  const validCount = rows.filter((r) => Object.keys(r.errors).length === 0).length;
  const errorCount = rows.length - validCount;
  const selectAllValid = () => {
    const next = new Set<number>();
    rows.forEach((r) => {
      if (Object.keys(r.errors).length === 0) next.add(r.rowIndex);
    });
    setSelected(next);
  };
  const selectNone = () => setSelected(new Set());
  const toggle = (idx: number) => {
    const next = new Set(selected);
    if (next.has(idx)) next.delete(idx);
    else next.add(idx);
    setSelected(next);
  };
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3 text-xs">
        <span className="text-slate-300">
          {t('import.valid_count', '{{n}} valid', { n: validCount })}
        </span>
        {errorCount > 0 && (
          <span className="text-priority-critical inline-flex items-center gap-1">
            <AlertTriangle size={11} />
            {t('import.error_count', '{{n}} with errors', { n: errorCount })}
          </span>
        )}
        <span className="ms-auto inline-flex items-center gap-2">
          <button
            onClick={selectAllValid}
            className="text-brand hover:underline"
          >
            {t('import.select_all_valid', 'Select all valid')}
          </button>
          <span className="text-slate-600">·</span>
          <button onClick={selectNone} className="text-slate-400 hover:underline">
            {t('import.select_none', 'Select none')}
          </button>
        </span>
      </div>
      <div className="border border-slate-700 rounded-lg overflow-hidden">
        <div className="max-h-[55vh] overflow-y-auto">
          <table className="w-full text-xs">
            <thead className="bg-surface-light text-slate-300 sticky top-0">
              <tr>
                <th className="text-start px-2 py-2 font-semibold w-8">#</th>
                <th className="text-start px-2 py-2 font-semibold w-8"></th>
                <th className="text-start px-2 py-2 font-semibold">
                  {FIELD_LABELS.head_name}
                </th>
                <th className="text-start px-2 py-2 font-semibold w-12">
                  {t('import.col_members', 'Members')}
                </th>
                <th className="text-start px-2 py-2 font-semibold">
                  {FIELD_LABELS.location_sector}
                </th>
                <th className="text-start px-2 py-2 font-semibold">
                  {FIELD_LABELS.displacement_status}
                </th>
                <th className="text-start px-2 py-2 font-semibold">
                  {t('import.col_warnings', 'Notes')}
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const hasErrors = Object.keys(r.errors).length > 0;
                const isChecked = selected.has(r.rowIndex);
                return (
                  <tr
                    key={r.rowIndex}
                    className={`border-t border-slate-700 ${
                      hasErrors ? 'bg-priority-critical/5' : ''
                    }`}
                  >
                    <td className="px-2 py-1.5 text-slate-500 font-mono">{r.rowIndex}</td>
                    <td className="px-2 py-1.5">
                      <input
                        type="checkbox"
                        checked={isChecked}
                        onChange={() => toggle(r.rowIndex)}
                        disabled={hasErrors}
                        className="accent-brand"
                        aria-label={`Row ${r.rowIndex}`}
                      />
                    </td>
                    <td className="px-2 py-1.5">
                      {r.family.head_name || (
                        <span className="text-priority-critical italic">
                          {t('import.missing_head', '(missing)')}
                        </span>
                      )}
                    </td>
                    <td className="px-2 py-1.5 font-mono">
                      {r.family.member_count}
                      {r.family.children_under_5 > 0 && (
                        <span className="text-slate-500 ms-1">
                          ({r.family.children_under_5}u5)
                        </span>
                      )}
                    </td>
                    <td className="px-2 py-1.5 text-slate-400">{r.family.location_sector}</td>
                    <td className="px-2 py-1.5 text-slate-400">{r.family.displacement_status}</td>
                    <td className="px-2 py-1.5">
                      {hasErrors ? (
                        <span className="text-priority-critical inline-flex items-center gap-1">
                          <AlertTriangle size={11} />
                          {Object.values(r.errors).join('; ')}
                        </span>
                      ) : r.warnings.length > 0 ? (
                        <span
                          className="text-priority-medium italic"
                          title={r.warnings.join('\n')}
                        >
                          {r.warnings.length}{' '}
                          {t('import.warnings_short', 'warning(s)')}
                        </span>
                      ) : (
                        <span className="text-slate-600">—</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function DoneStep({
  result,
  t,
}: {
  result: ImportResult;
  t: (k: string, ...args: unknown[]) => string;
}) {
  return (
    <div className="space-y-3 py-4">
      <div className="flex items-center gap-3 px-3 py-2 rounded-lg bg-priority-normal/10 border border-priority-normal/30 text-priority-normal text-sm font-semibold">
        <CheckCircle2 size={16} />
        {t('import.imported_count', '{{n}} families imported.', { n: result.imported })}
      </div>
      {result.skipped > 0 && (
        <div className="text-xs text-slate-400">
          {t('import.skipped_count', '{{n}} rows skipped (validation errors or unchecked).', {
            n: result.skipped,
          })}
        </div>
      )}
      {result.errors.length > 0 && (
        <div className="text-xs">
          <div className="font-semibold text-priority-medium mb-1">
            {t('import.errors_heading', 'Errors:')}
          </div>
          <ul className="space-y-0.5 max-h-40 overflow-y-auto">
            {result.errors.map((e, i) => (
              <li key={i} className="text-slate-400">
                <span className="text-slate-500 me-2">Row {e.rowIndex}:</span>
                {e.message}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
