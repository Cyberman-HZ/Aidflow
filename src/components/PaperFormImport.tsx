// PaperFormImport — the "snap a photo of your paper form, register the
// families" feature.
//
// This is the project's headline Gemma-4-multimodal moment: the admin
// (or a worker on a tablet) uploads a photograph of a handwritten
// registration sheet or tally, Gemma 4 vision reads each row, and the
// admin reviews + Applies each extracted family.
//
// UI flow:
//
//   ┌──────────┐   pick    ┌──────────┐  analyze   ┌──────────┐  apply  ┌──────────┐
//   │ "Pick a  │ ────────▶ │ "Preview │ ─────────▶ │ "Review  │ ──────▶ │ "Done"   │
//   │  photo"  │           │  + go"   │            │  cards"  │         │  summary │
//   └──────────┘           └──────────┘            └──────────┘         └──────────┘
//
// Privacy contract: the image never leaves the laptop. It goes to Ollama
// at localhost via chatWithImage(). Once extraction completes we drop the
// in-memory base64 string — nothing is persisted to disk.

import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  X as XIcon,
  Camera,
  Upload,
  Sparkles,
  CheckCircle2,
  AlertTriangle,
  Edit2,
  Image as ImageIcon,
  RefreshCw,
} from 'lucide-react';
import {
  fileToResizedJpegBase64,
  approxBase64Kb,
  type ResizedImage,
} from '@/services/imageUtils';
import {
  extractFamiliesFromPhoto,
  commitFamilyCandidate,
  type FamilyCandidate,
  type ConfidenceTag,
} from '@/services/formIngest';
import type { DisplacementStatus, IncomeLevel } from '@/types';

// ---------------------------------------------------------------------------
// State machine
// ---------------------------------------------------------------------------

type Stage = 'pick' | 'preview' | 'analyzing' | 'review' | 'done';

interface CardStatus {
  status: 'pending' | 'applying' | 'applied' | 'discarded' | 'failed';
  error?: string;
  applied_family_id?: string;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function PaperFormImport({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const [stage, setStage] = useState<Stage>('pick');
  const [image, setImage] = useState<ResizedImage | null>(null);
  const [candidates, setCandidates] = useState<FamilyCandidate[]>([]);
  const [imageWarnings, setImageWarnings] = useState<string[]>([]);
  const [pickError, setPickError] = useState<string | null>(null);
  const [ingestError, setIngestError] = useState<string | null>(null);
  const [byId, setById] = useState<Record<string, CardStatus>>({});
  const fileRef = useRef<HTMLInputElement>(null);
  const cameraRef = useRef<HTMLInputElement>(null);

  // ── ESC closes the modal ────────────────────────────────────────────
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && stage !== 'analyzing') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, stage]);

  // ── File pick handler ──────────────────────────────────────────────
  const onPick = async (file: File | undefined) => {
    setPickError(null);
    if (!file) return;
    try {
      const resized = await fileToResizedJpegBase64(file, {
        maxDim: 1280, // a bit higher than 1024 — handwriting needs detail
        quality: 0.85,
      });
      setImage(resized);
      setStage('preview');
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setPickError(msg);
    }
  };

  // ── Run the multimodal extraction ──────────────────────────────────
  const onAnalyze = async () => {
    if (!image) return;
    setStage('analyzing');
    setIngestError(null);
    setImageWarnings([]);
    try {
      const result = await extractFamiliesFromPhoto(image.base64);
      setCandidates(result.candidates);
      setImageWarnings(result.warnings);
      // Seed each card's status as pending.
      const seed: Record<string, CardStatus> = {};
      for (const c of result.candidates) seed[c.candidate_id] = { status: 'pending' };
      setById(seed);
      setStage('review');
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setIngestError(msg);
      setStage('preview'); // back to where they came from so they can retry
    }
  };

  // ── Inline edit of a candidate ─────────────────────────────────────
  const patchCandidate = (id: string, patch: Partial<FamilyCandidate>) => {
    setCandidates((arr) =>
      arr.map((c) => (c.candidate_id === id ? { ...c, ...patch } : c))
    );
  };

  // ── Apply / Discard one card ───────────────────────────────────────
  const applyOne = async (c: FamilyCandidate) => {
    const cur = byId[c.candidate_id]?.status ?? 'pending';
    if (cur === 'applying' || cur === 'applied' || cur === 'discarded') return;
    setById((s) => ({ ...s, [c.candidate_id]: { status: 'applying' } }));
    try {
      const fam = await commitFamilyCandidate(c);
      setById((s) => ({
        ...s,
        [c.candidate_id]: { status: 'applied', applied_family_id: fam.family_id },
      }));
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setById((s) => ({ ...s, [c.candidate_id]: { status: 'failed', error: msg } }));
    }
  };

  const discardOne = (c: FamilyCandidate) =>
    setById((s) => ({ ...s, [c.candidate_id]: { status: 'discarded' } }));

  const applyAll = async () => {
    for (const c of candidates) {
      const cur = byId[c.candidate_id]?.status ?? 'pending';
      if (cur === 'pending' || cur === 'failed') {
        // Sequential rather than parallel so the priority recompute inside
        // commitFamilyCandidate doesn't fight itself in the rare case where
        // two records arrive in the same Dexie tick.
        // eslint-disable-next-line no-await-in-loop
        await applyOne(c);
      }
    }
  };

  // ── Summary numbers shown in the footer ─────────────────────────────
  const stats = (() => {
    let applied = 0;
    let discarded = 0;
    let pending = 0;
    let failed = 0;
    for (const c of candidates) {
      const s = byId[c.candidate_id]?.status ?? 'pending';
      if (s === 'applied') applied++;
      else if (s === 'discarded') discarded++;
      else if (s === 'failed') failed++;
      else pending++;
    }
    return { applied, discarded, pending, failed, total: candidates.length };
  })();

  // ----------------------------------------------------------------------
  // Render — single dialog with stage-based body
  // ----------------------------------------------------------------------
  return (
    <div
      className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="paper-form-import-title"
    >
      <div className="bg-surface border border-slate-700 rounded-xl w-full max-w-4xl max-h-[90vh] flex flex-col shadow-2xl">
        {/* ── Header ────────────────────────────────────────────────── */}
        <div className="flex items-center justify-between p-4 border-b border-slate-700">
          <div className="flex items-center gap-2 min-w-0">
            <Camera size={18} className="text-ai flex-shrink-0" />
            <div className="min-w-0">
              <h2
                id="paper-form-import-title"
                className="text-lg font-semibold truncate"
              >
                {t('paper_form.title') ?? 'Import families from a photo'}
              </h2>
              <p className="text-xs text-slate-400 truncate">
                {t('paper_form.subtitle') ??
                  'Snap a registration form. Gemma 4 vision reads each row offline. You review and Apply.'}
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            disabled={stage === 'analyzing'}
            className="touch-target p-1 rounded hover:bg-surface-light disabled:opacity-30 disabled:cursor-not-allowed"
            aria-label="Close"
          >
            <XIcon size={18} />
          </button>
        </div>

        {/* ── Body ──────────────────────────────────────────────────── */}
        <div className="flex-1 overflow-y-auto p-4">
          {stage === 'pick' && (
            <PickStage
              onPickFile={() => fileRef.current?.click()}
              onPickCamera={() => cameraRef.current?.click()}
              error={pickError}
              t={t}
            />
          )}

          {stage === 'preview' && image && (
            <PreviewStage
              image={image}
              onChange={() => {
                setImage(null);
                setStage('pick');
              }}
              ingestError={ingestError}
              onAnalyze={() => void onAnalyze()}
              t={t}
            />
          )}

          {stage === 'analyzing' && (
            <AnalyzingStage previewUrl={image?.dataUrl} t={t} />
          )}

          {stage === 'review' && (
            <ReviewStage
              candidates={candidates}
              byId={byId}
              imageWarnings={imageWarnings}
              previewUrl={image?.dataUrl}
              onPatch={patchCandidate}
              onApply={applyOne}
              onDiscard={discardOne}
              t={t}
            />
          )}

          {stage === 'done' && (
            <DoneStage stats={stats} onClose={onClose} t={t} />
          )}
        </div>

        {/* ── Footer ─────────────────────────────────────────────────── */}
        {stage === 'review' && candidates.length > 0 && (
          <div className="border-t border-slate-700 px-4 py-3 flex items-center justify-between gap-3 flex-wrap">
            <div className="text-xs text-slate-400 flex items-center gap-3 flex-wrap">
              <span>
                {stats.applied} {t('paper_form.applied') ?? 'applied'}
              </span>
              <span>
                {stats.pending} {t('paper_form.pending') ?? 'pending'}
              </span>
              {stats.discarded > 0 && (
                <span>
                  {stats.discarded} {t('paper_form.discarded') ?? 'discarded'}
                </span>
              )}
              {stats.failed > 0 && (
                <span className="text-priority-critical">
                  {stats.failed} {t('paper_form.failed') ?? 'failed'}
                </span>
              )}
            </div>
            <div className="flex gap-2">
              <button
                onClick={() => void applyAll()}
                disabled={stats.pending === 0 && stats.failed === 0}
                className="touch-target px-3 py-1.5 bg-brand hover:bg-brand-dark disabled:opacity-40 disabled:cursor-not-allowed text-white text-xs font-semibold rounded-md flex items-center gap-1"
              >
                <CheckCircle2 size={13} />
                {t('paper_form.apply_all') ?? 'Apply all remaining'}
              </button>
              <button
                onClick={() => setStage('done')}
                className="touch-target px-3 py-1.5 bg-surface-deep hover:bg-slate-700 text-slate-200 text-xs rounded-md"
              >
                {t('paper_form.finish') ?? 'Finish'}
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Hidden file inputs (declared once, triggered from both stages) */}
      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        hidden
        onChange={(e) => void onPick(e.target.files?.[0])}
      />
      <input
        ref={cameraRef}
        type="file"
        accept="image/*"
        capture="environment"
        hidden
        onChange={(e) => void onPick(e.target.files?.[0])}
      />
    </div>
  );
}

// ===========================================================================
// Stage panels
// ===========================================================================

type T = (k: string, opts?: Record<string, unknown>) => string;

function PickStage({
  onPickFile,
  onPickCamera,
  error,
  t,
}: {
  onPickFile: () => void;
  onPickCamera: () => void;
  error: string | null;
  t: T;
}) {
  return (
    <div className="space-y-4">
      <div className="bg-surface-deep border border-slate-700 rounded-lg p-6 text-center">
        <ImageIcon size={36} className="mx-auto text-slate-500 mb-3" />
        <p className="text-sm text-slate-300 mb-1">
          {t('paper_form.pick_prompt') ??
            'Upload a clear photo of a paper registration form or family tally sheet.'}
        </p>
        <p className="text-xs text-slate-500 mb-4">
          {t('paper_form.pick_tip') ??
            'JPG/PNG up to 25 MB. The image is processed locally — it never leaves this device.'}
        </p>
        <div className="flex justify-center gap-2 flex-wrap">
          <button
            onClick={onPickCamera}
            className="touch-target px-4 py-2 bg-brand hover:bg-brand-dark text-white text-sm font-semibold rounded-md flex items-center gap-2"
          >
            <Camera size={14} />
            {t('paper_form.use_camera') ?? 'Use camera'}
          </button>
          <button
            onClick={onPickFile}
            className="touch-target px-4 py-2 bg-surface-light hover:bg-slate-600 text-slate-100 text-sm rounded-md flex items-center gap-2"
          >
            <Upload size={14} />
            {t('paper_form.pick_file') ?? 'Pick a file'}
          </button>
        </div>
        {error && (
          <div className="mt-4 text-xs text-priority-critical bg-priority-critical/10 border border-priority-critical/30 rounded-md px-3 py-2 inline-block">
            {error}
          </div>
        )}
      </div>
      <PrivacyFooter t={t} />
    </div>
  );
}

function PreviewStage({
  image,
  ingestError,
  onChange,
  onAnalyze,
  t,
}: {
  image: ResizedImage;
  ingestError: string | null;
  onChange: () => void;
  onAnalyze: () => void;
  t: T;
}) {
  return (
    <div className="space-y-4">
      <div className="bg-surface-deep border border-slate-700 rounded-lg overflow-hidden">
        <img
          src={image.dataUrl}
          alt={t('paper_form.preview_alt') ?? 'Paper form preview'}
          className="w-full max-h-[50vh] object-contain bg-black"
        />
        <div className="px-3 py-2 text-xs text-slate-400 border-t border-slate-700 flex flex-wrap items-center gap-3">
          <span>
            {image.width} × {image.height}px
          </span>
          <span>{approxBase64Kb(image.base64)} KB</span>
          <button
            onClick={onChange}
            className="ml-auto underline hover:text-slate-200"
          >
            {t('paper_form.change_photo') ?? 'change photo'}
          </button>
        </div>
      </div>
      {ingestError && (
        <div className="text-xs text-priority-critical bg-priority-critical/10 border border-priority-critical/30 rounded-md px-3 py-2">
          <div className="font-semibold flex items-center gap-1">
            <AlertTriangle size={13} /> {t('paper_form.ingest_failed') ?? 'Extraction failed'}
          </div>
          <div className="mt-1 opacity-90">{ingestError}</div>
        </div>
      )}
      <div className="flex justify-end gap-2">
        <button
          onClick={onChange}
          className="touch-target px-4 py-2 bg-surface-light hover:bg-slate-600 text-slate-200 text-sm rounded-md"
        >
          {t('common.cancel') ?? 'Cancel'}
        </button>
        <button
          onClick={onAnalyze}
          className="touch-target px-4 py-2 bg-ai hover:bg-violet-600 text-white text-sm font-semibold rounded-md flex items-center gap-2"
        >
          <Sparkles size={14} />
          {t('paper_form.analyze') ?? 'Extract families with Gemma 4'}
        </button>
      </div>
      <PrivacyFooter t={t} />
    </div>
  );
}

function AnalyzingStage({ previewUrl, t }: { previewUrl: string | undefined; t: T }) {
  return (
    <div className="py-10 text-center space-y-4">
      {previewUrl && (
        <img
          src={previewUrl}
          alt=""
          className="w-32 h-32 object-cover rounded-lg mx-auto opacity-60"
        />
      )}
      <div className="flex items-center justify-center gap-2 text-sm text-slate-300">
        <Sparkles size={16} className="text-ai animate-pulse" />
        <span>
          {t('paper_form.analyzing') ??
            'Gemma 4 is reading the form locally — this can take 30 s to a few minutes on a CPU.'}
        </span>
      </div>
      <p className="text-xs text-slate-500 max-w-md mx-auto">
        {t('paper_form.analyzing_tip') ??
          'Multimodal inference is much heavier than text. Don\'t close this dialog.'}
      </p>
    </div>
  );
}

function ReviewStage({
  candidates,
  byId,
  imageWarnings,
  previewUrl,
  onPatch,
  onApply,
  onDiscard,
  t,
}: {
  candidates: FamilyCandidate[];
  byId: Record<string, CardStatus>;
  imageWarnings: string[];
  previewUrl: string | undefined;
  onPatch: (id: string, patch: Partial<FamilyCandidate>) => void;
  onApply: (c: FamilyCandidate) => Promise<void>;
  onDiscard: (c: FamilyCandidate) => void;
  t: T;
}) {
  if (candidates.length === 0) {
    return (
      <div className="py-10 text-center space-y-3">
        <AlertTriangle size={28} className="mx-auto text-amber-400" />
        <p className="text-sm text-slate-200">
          {t('paper_form.no_rows') ??
            "Gemma 4 didn't find any family rows in that photo."}
        </p>
        {imageWarnings.length > 0 && (
          <ul className="text-xs text-slate-400 max-w-md mx-auto list-disc list-inside space-y-1">
            {imageWarnings.map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
        )}
        <p className="text-xs text-slate-500 max-w-md mx-auto">
          {t('paper_form.no_rows_tip') ??
            'Try a clearer, well-lit photo, or use the Add family button to enter the data manually.'}
        </p>
      </div>
    );
  }
  return (
    <div className="space-y-4">
      {imageWarnings.length > 0 && (
        <div className="text-xs text-amber-400 bg-amber-500/10 border border-amber-500/30 rounded-md px-3 py-2">
          <div className="font-semibold flex items-center gap-1 mb-1">
            <AlertTriangle size={13} />
            {t('paper_form.image_warnings') ?? 'Notes about the image'}
          </div>
          <ul className="list-disc list-inside space-y-0.5 opacity-90">
            {imageWarnings.map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
        </div>
      )}
      <div className="text-xs text-slate-400 flex items-center gap-3 flex-wrap">
        {previewUrl && (
          <img
            src={previewUrl}
            alt=""
            className="w-10 h-10 rounded object-cover opacity-70"
          />
        )}
        <span>
          {t('paper_form.review_intro', { count: candidates.length }) ??
            `Found ${candidates.length} candidate famil${
              candidates.length === 1 ? 'y' : 'ies'
            }. Review and Apply each one.`}
        </span>
      </div>
      <div className="space-y-3">
        {candidates.map((c) => (
          <CandidateCard
            key={c.candidate_id}
            c={c}
            status={byId[c.candidate_id] ?? { status: 'pending' }}
            onPatch={(patch) => onPatch(c.candidate_id, patch)}
            onApply={() => void onApply(c)}
            onDiscard={() => onDiscard(c)}
            t={t}
          />
        ))}
      </div>
    </div>
  );
}

function DoneStage({
  stats,
  onClose,
  t,
}: {
  stats: { applied: number; discarded: number; pending: number; failed: number; total: number };
  onClose: () => void;
  t: T;
}) {
  return (
    <div className="py-10 text-center space-y-3">
      <CheckCircle2 size={36} className="mx-auto text-priority-normal" />
      <h3 className="text-base font-semibold">
        {t('paper_form.done_title', { n: stats.applied }) ??
          `Added ${stats.applied} famil${stats.applied === 1 ? 'y' : 'ies'} to the registry`}
      </h3>
      <p className="text-xs text-slate-400">
        {stats.discarded > 0 && `${stats.discarded} discarded. `}
        {stats.failed > 0 && `${stats.failed} failed. `}
        {stats.pending > 0 && `${stats.pending} not applied.`}
      </p>
      <button
        onClick={onClose}
        className="touch-target px-4 py-2 bg-brand hover:bg-brand-dark text-white text-sm font-semibold rounded-md"
      >
        {t('common.close') ?? 'Close'}
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// CandidateCard — one extracted family, editable in place
// ---------------------------------------------------------------------------

function CandidateCard({
  c,
  status,
  onPatch,
  onApply,
  onDiscard,
  t,
}: {
  c: FamilyCandidate;
  status: CardStatus;
  onPatch: (patch: Partial<FamilyCandidate>) => void;
  onApply: () => void;
  onDiscard: () => void;
  t: T;
}) {
  const [showRaw, setShowRaw] = useState(false);

  if (status.status === 'applied') {
    return (
      <div className="rounded-lg border border-priority-normal/30 bg-priority-normal/10 px-3 py-2 flex items-center gap-2 text-sm">
        <CheckCircle2 size={14} className="text-priority-normal flex-shrink-0" />
        <span className="text-priority-normal font-medium">{c.head_name}</span>
        <span className="text-xs text-slate-400">
          → {status.applied_family_id}
        </span>
      </div>
    );
  }
  if (status.status === 'discarded') {
    return (
      <div className="rounded-lg border border-slate-700 bg-surface-deep px-3 py-2 flex items-center gap-2 text-sm text-slate-400">
        <XIcon size={14} className="flex-shrink-0" />
        <span className="line-through">{c.head_name}</span>
        <span className="ms-auto text-xs italic">{t('paper_form.discarded') ?? 'discarded'}</span>
      </div>
    );
  }

  const confidenceColor: Record<ConfidenceTag, string> = {
    high: 'text-priority-normal border-priority-normal/30 bg-priority-normal/10',
    medium: 'text-amber-400 border-amber-500/30 bg-amber-500/10',
    low: 'text-priority-critical border-priority-critical/30 bg-priority-critical/10',
  };

  return (
    <div className="rounded-lg border border-slate-700 bg-surface-deep p-3 space-y-3">
      {/* Top row — name + confidence + action buttons */}
      <div className="flex items-start gap-2 flex-wrap">
        <div className="flex-1 min-w-0">
          <input
            value={c.head_name}
            onChange={(e) => onPatch({ head_name: e.target.value })}
            placeholder={t('paper_form.field_head_name') ?? 'Head of household'}
            className="w-full bg-surface border border-slate-700 rounded px-2 py-1.5 text-sm font-semibold focus:border-brand outline-none"
            disabled={status.status === 'applying'}
          />
        </div>
        <span
          className={`text-[10px] px-2 py-0.5 rounded-full border font-semibold uppercase tracking-wide flex-shrink-0 ${
            confidenceColor[c.confidence]
          }`}
          title={t('paper_form.confidence_tooltip') ?? "Gemma 4's self-rated confidence on this row"}
        >
          {c.confidence}
        </span>
      </div>

      {/* Field grid — compact 3-column layout */}
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 text-xs">
        <NumberField
          label={t('paper_form.field_member_count') ?? 'Members'}
          value={c.member_count}
          min={1}
          max={30}
          onChange={(v) => onPatch({ member_count: v })}
          disabled={status.status === 'applying'}
        />
        <NumberField
          label={t('paper_form.field_children_under_5') ?? 'Children <5'}
          value={c.children_under_5}
          min={0}
          max={15}
          onChange={(v) => onPatch({ children_under_5: v })}
          disabled={status.status === 'applying'}
        />
        <NumberField
          label={t('paper_form.field_elderly_count') ?? 'Elderly'}
          value={c.elderly_count}
          min={0}
          max={10}
          onChange={(v) => onPatch({ elderly_count: v })}
          disabled={status.status === 'applying'}
        />
        <EnumField
          label={t('paper_form.field_displacement') ?? 'Displacement'}
          value={c.displacement_status}
          options={[
            { value: 'resident', label: t('displacement.resident') ?? 'Resident' },
            { value: 'recently_displaced', label: t('displacement.recently_displaced') ?? 'Recently displaced' },
            { value: 'refugee', label: t('displacement.refugee') ?? 'Refugee' },
          ]}
          onChange={(v) => onPatch({ displacement_status: v as DisplacementStatus })}
          disabled={status.status === 'applying'}
        />
        <EnumField
          label={t('paper_form.field_income') ?? 'Income'}
          value={c.income_level}
          options={[
            { value: 'none', label: t('income.none') ?? 'None' },
            { value: 'minimal', label: t('income.minimal') ?? 'Minimal' },
            { value: 'moderate', label: t('income.moderate') ?? 'Moderate' },
          ]}
          onChange={(v) => onPatch({ income_level: v as IncomeLevel })}
          disabled={status.status === 'applying'}
        />
        <TextField
          label={t('paper_form.field_sector') ?? 'Sector'}
          value={c.location_sector}
          onChange={(v) => onPatch({ location_sector: v })}
          disabled={status.status === 'applying'}
        />
      </div>

      {/* Checkbox + warnings */}
      <div className="flex flex-wrap items-center gap-3 text-xs">
        <label className="flex items-center gap-1.5 text-slate-300 cursor-pointer">
          <input
            type="checkbox"
            checked={c.has_pregnant_member}
            onChange={(e) => onPatch({ has_pregnant_member: e.target.checked })}
            disabled={status.status === 'applying'}
            className="accent-brand"
          />
          {t('paper_form.field_pregnant') ?? 'Pregnant / nursing member'}
        </label>
        {c.warnings.length > 0 && (
          <div className="text-amber-400 flex items-center gap-1">
            <AlertTriangle size={11} />
            <span className="italic">{c.warnings.join('; ')}</span>
          </div>
        )}
      </div>

      {/* Medical + notes */}
      {(c.medical_conditions.length > 0 || c.notes) && (
        <div className="text-xs text-slate-300 space-y-1">
          {c.medical_conditions.length > 0 && (
            <div>
              <span className="text-slate-500 me-1">
                {t('paper_form.field_medical') ?? 'Medical:'}
              </span>
              {c.medical_conditions.join(', ')}
            </div>
          )}
          {c.notes && (
            <div>
              <span className="text-slate-500 me-1">
                {t('paper_form.field_notes') ?? 'Notes:'}
              </span>
              {c.notes}
            </div>
          )}
        </div>
      )}

      {/* Raw text toggle (debug-ish but useful for trust) */}
      {c.raw_text && (
        <div className="text-[10px]">
          <button
            type="button"
            onClick={() => setShowRaw((s) => !s)}
            className="text-slate-500 hover:text-slate-300 underline"
          >
            {showRaw
              ? t('paper_form.hide_raw') ?? 'hide raw text'
              : t('paper_form.show_raw') ?? 'show raw text Gemma read'}
          </button>
          {showRaw && (
            <pre className="mt-1 text-slate-400 whitespace-pre-wrap bg-surface px-2 py-1.5 rounded border border-slate-800">
              {c.raw_text}
            </pre>
          )}
        </div>
      )}

      {/* Action buttons */}
      <div className="flex items-center gap-2 pt-2 border-t border-slate-700">
        {status.status === 'failed' && status.error && (
          <div className="text-[11px] text-priority-critical flex-1 min-w-0 truncate">
            ⚠ {status.error}
          </div>
        )}
        <div className="ms-auto flex gap-2">
          <button
            onClick={onDiscard}
            disabled={status.status === 'applying'}
            className="touch-target px-3 py-1.5 bg-surface hover:bg-slate-700 text-slate-300 text-xs rounded-md flex items-center gap-1 disabled:opacity-40"
          >
            <XIcon size={12} />
            {t('common.discard') ?? 'Discard'}
          </button>
          <button
            onClick={onApply}
            disabled={status.status === 'applying' || !c.head_name.trim()}
            className="touch-target px-3 py-1.5 bg-brand hover:bg-brand-dark disabled:opacity-40 disabled:cursor-not-allowed text-white text-xs font-semibold rounded-md flex items-center gap-1"
          >
            {status.status === 'applying' ? (
              <RefreshCw size={12} className="animate-spin" />
            ) : status.status === 'failed' ? (
              <Edit2 size={12} />
            ) : (
              <CheckCircle2 size={12} />
            )}
            {status.status === 'failed'
              ? t('common.retry') ?? 'Retry'
              : t('common.apply') ?? 'Apply'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tiny field components — kept inside this file because they're only used here
// ---------------------------------------------------------------------------

function NumberField({
  label,
  value,
  min,
  max,
  onChange,
  disabled,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  onChange: (v: number) => void;
  disabled?: boolean;
}) {
  return (
    <label className="flex flex-col gap-0.5 text-slate-400">
      <span>{label}</span>
      <input
        type="number"
        min={min}
        max={max}
        value={value}
        onChange={(e) => {
          const n = Number(e.target.value);
          if (!Number.isFinite(n)) return;
          onChange(Math.max(min, Math.min(max, Math.floor(n))));
        }}
        disabled={disabled}
        className="bg-surface border border-slate-700 rounded px-2 py-1 text-sm text-slate-100 focus:border-brand outline-none disabled:opacity-60"
      />
    </label>
  );
}

function TextField({
  label,
  value,
  onChange,
  disabled,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  disabled?: boolean;
}) {
  return (
    <label className="flex flex-col gap-0.5 text-slate-400">
      <span>{label}</span>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        className="bg-surface border border-slate-700 rounded px-2 py-1 text-sm text-slate-100 focus:border-brand outline-none disabled:opacity-60"
      />
    </label>
  );
}

function EnumField({
  label,
  value,
  options,
  onChange,
  disabled,
}: {
  label: string;
  value: string;
  options: { value: string; label: string }[];
  onChange: (v: string) => void;
  disabled?: boolean;
}) {
  return (
    <label className="flex flex-col gap-0.5 text-slate-400">
      <span>{label}</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        className="bg-surface border border-slate-700 rounded px-2 py-1 text-sm text-slate-100 focus:border-brand outline-none disabled:opacity-60"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}

function PrivacyFooter({ t }: { t: T }) {
  return (
    <div className="text-[11px] text-slate-500 text-center px-2">
      {t('paper_form.privacy') ??
        'The image is processed on this device via Ollama. It is not uploaded anywhere.'}
    </div>
  );
}
