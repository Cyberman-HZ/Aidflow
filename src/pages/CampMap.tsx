// AidFlow Pro — Drone Camp Planner page.
//
// One sidebar tab (/camp-map). Workflow:
//   1. Empty state → user uploads an aerial image (drone, phone-from-roof,
//      satellite screenshot). We resize + send to Gemma 4 vision → store.
//   2. Canvas renders the image + the AI-detected features as an SVG
//      overlay. Toolbar lets the user switch between View / Pin / Hazard.
//   3. Right-rail insights panel computes the 9 operational tasks live
//      from the current features + family-pin set.
//
// Everything stays on the device. Image bytes live in IndexedDB; vision
// runs on local Ollama; insights are pure local computation.

import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Plane,
  Upload,
  Trash2,
  AlertTriangle,
  Sparkles,
  ImageIcon,
  Loader2,
  Layers,
  History,
} from 'lucide-react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '@/db/database';
import { Card } from '@/components/Card';
import CampMapCanvas, {
  type CanvasMode,
  type EditBrushType,
} from '@/components/CampMapCanvas';
import CampMapInsights from '@/components/CampMapInsights';
import TraceButton from '@/components/TraceButton';
import {
  analyzeAndStoreImage,
  deleteCampMap,
  diffSnapshots,
  listCampMaps,
  nextFeatureId,
  setAvgHouseholdSize,
  setFamilyPins,
  setFeatures,
  setHazardZones,
  type SnapshotDiff,
} from '@/services/campMap';
import type {
  CampFamilyPin,
  CampFeature,
  CampHazardZone,
  CampMap as CampMapRow,
  Family,
} from '@/types';
import { useAuthStore } from '@/stores/authStore';
import { useSettingsStore } from '@/stores/settingsStore';

const DEMO_IMAGE_PATH = '/screenshots/camp-map/demo.jpg';

export default function CampMap() {
  const { t } = useTranslation();
  const user = useAuthStore((s) => s.user);
  const language = useSettingsStore((s) => s.language);

  const snapshots = useLiveQuery(() => listCampMaps(), []) ?? ([] as CampMapRow[]);
  const families = useLiveQuery(
    () => db.families.toArray().then((rows) => rows.filter((f) => !f.deleted_at)),
    []
  ) ?? ([] as Family[]);
  const history = useLiveQuery(() => db.distributions.toArray(), []) ?? [];

  // Active = the snapshot displayed on the canvas. Compare = an older one
  // we diff the active against, drawn as an overlay. null on compareId
  // means "no comparison".
  const [activeId, setActiveId] = useState<string | null>(null);
  const [compareId, setCompareId] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<CanvasMode>('view');
  const [showSuggestions, setShowSuggestions] = useState(true);
  // Family-pin "click a tent then pick a family" sub-flow.
  const [pendingTentId, setPendingTentId] = useState<string | null>(null);

  // Whenever the list changes, make sure activeId points at something real.
  // Defaults to the newest snapshot when nothing is selected.
  useEffect(() => {
    if (snapshots.length === 0) {
      if (activeId) setActiveId(null);
      if (compareId) setCompareId(null);
      return;
    }
    if (!activeId || !snapshots.some((s) => s.id === activeId)) {
      setActiveId(snapshots[0].id);
    }
    if (compareId && !snapshots.some((s) => s.id === compareId)) {
      setCompareId(null);
    }
  }, [snapshots, activeId, compareId]);

  const campMap = useMemo<CampMapRow | undefined>(
    () => snapshots.find((s) => s.id === activeId),
    [snapshots, activeId]
  );
  const compareMap = useMemo<CampMapRow | null>(
    () => snapshots.find((s) => s.id === compareId) ?? null,
    [snapshots, compareId]
  );
  const diff = useMemo<SnapshotDiff | null>(
    () => (campMap && compareMap ? diffSnapshots(campMap, compareMap) : null),
    [campMap, compareMap]
  );

  // Construct a stable object URL for the stored image Blob.
  const imageUrl = useMemo(() => {
    if (!campMap?.image) return DEMO_IMAGE_PATH;
    return URL.createObjectURL(campMap.image);
  }, [campMap?.image]);
  // Revoke object URLs to avoid memory leaks.
  useEffect(() => {
    return () => {
      if (imageUrl && imageUrl.startsWith('blob:')) URL.revokeObjectURL(imageUrl);
    };
  }, [imageUrl]);

  const onUpload = async (file: File) => {
    if (!file || !user) return;
    setUploading(true);
    setError(null);
    try {
      const { campMap: created } = await analyzeAndStoreImage(file, {
        uploaded_by: user.user_id,
        language,
        source_kind: 'drone',
      });
      // Make the freshly-uploaded snapshot active so the user sees the
      // result. If there was already a snapshot, suggest it as the
      // comparison baseline so the diff is visible immediately.
      const prevLatest = snapshots[0];
      setActiveId(created.id);
      if (prevLatest && prevLatest.id !== created.id && compareId == null) {
        setCompareId(prevLatest.id);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setUploading(false);
    }
  };

  const onDeleteSnapshot = async () => {
    if (!campMap) return;
    if (
      !confirm(
        t(
          'camp_map.confirm_delete',
          'Delete this snapshot? Family pins and hazard zones on this snapshot will be lost. Other snapshots are unaffected.'
        ) as string
      )
    )
      return;
    await deleteCampMap(campMap.id);
    setMode('view');
    setPendingTentId(null);
    if (compareId === campMap.id) setCompareId(null);
  };

  const onPickTent = (featureId: string) => {
    if (!campMap) return;
    // If a pin already exists for this tent, toggle it off; otherwise
    // queue it and open the family picker.
    const existing = campMap.family_pins.find((p) => p.feature_id === featureId);
    if (existing) {
      void setFamilyPins(
        campMap.id,
        campMap.family_pins.filter((p) => p.feature_id !== featureId)
      );
      return;
    }
    setPendingTentId(featureId);
  };

  const onPickFamily = (family_id: string) => {
    if (!campMap || !pendingTentId) return;
    const pin: CampFamilyPin = {
      family_id,
      feature_id: pendingTentId,
      source: 'manual',
    };
    // De-dup: a single family pin per tent, and a single tent pin per family.
    const next = campMap.family_pins
      .filter((p) => p.feature_id !== pendingTentId && p.family_id !== family_id)
      .concat(pin);
    void setFamilyPins(campMap.id, next);
    setPendingTentId(null);
  };

  const onAddHazardZone = (zone: CampHazardZone) => {
    if (!campMap) return;
    void setHazardZones(campMap.id, [...campMap.hazard_zones, zone]);
  };

  const onAddFeature = (input: { type: EditBrushType; x: number; y: number }) => {
    if (!campMap) return;
    const id = nextFeatureId(campMap.features, input.type);
    const added: CampFeature = {
      id,
      type: input.type,
      x: input.x,
      y: input.y,
      // Admin-added features get max confidence — they're hand-placed.
      confidence: 'high',
    };
    void setFeatures(campMap.id, [...campMap.features, added]);
  };

  const onDeleteFeature = (featureId: string) => {
    if (!campMap) return;
    void setFeatures(
      campMap.id,
      campMap.features.filter((f) => f.id !== featureId)
    );
  };

  return (
    <div className="space-y-5">
      {/* ---------- Header ---------- */}
      <header>
        <h1 className="text-2xl font-bold flex items-center gap-2 flex-wrap">
          <Plane size={22} className="text-ai" />
          {t('camp_map.title', 'Drone Camp Planner')}
          <span className="text-[10px] font-semibold uppercase tracking-wider bg-ai/15 text-ai border border-ai/30 rounded-full px-2 py-0.5">
            {t('camp_map.beta', 'Beta')}
          </span>
        </h1>
        <p className="text-sm text-slate-400 mt-1">
          {t(
            'camp_map.subtitle',
            'Upload an aerial / drone image of the site. Gemma 4 vision identifies tents, water points, latrines, paths, and open areas. The right-hand panel turns that layout into nine operational planning tasks — all offline.'
          )}
        </p>
      </header>

      {/* ---------- Upload / Clear toolbar ---------- */}
      <Card>
        <div className="flex flex-wrap items-center gap-3">
          <label className="touch-target px-3 py-2 bg-brand hover:bg-brand-dark rounded-md text-sm font-semibold flex items-center gap-2 cursor-pointer">
            <Upload size={14} />
            {uploading ? (
              <>
                <Loader2 size={14} className="animate-spin" />
                {t('camp_map.uploading', 'Analyzing image…')}
              </>
            ) : campMap ? (
              t('camp_map.upload_replace', 'Upload new image')
            ) : (
              t('camp_map.upload_first', 'Upload aerial image')
            )}
            <input
              type="file"
              accept="image/*"
              disabled={uploading}
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void onUpload(f);
                e.target.value = '';
              }}
              className="hidden"
            />
          </label>

          {campMap && (
            <button
              onClick={() => void onDeleteSnapshot()}
              disabled={uploading}
              className="touch-target px-3 py-2 text-xs text-priority-critical hover:underline flex items-center gap-1"
              title={t('camp_map.delete_one', 'Delete this snapshot only — other snapshots are kept') as string}
            >
              <Trash2 size={12} />
              {t('camp_map.delete_snapshot', 'Delete this snapshot')}
            </button>
          )}

          {campMap?.last_trace_id && (
            <TraceButton
              traceId={campMap.last_trace_id}
              variant="badge"
              label={t('camp_map.trace_link', 'Trace last analysis') as string}
            />
          )}

          <span className="text-xs text-slate-500 ms-auto">
            {campMap
              ? `${campMap.features.length} ${t('camp_map.features_detected', 'features')} · ${campMap.image_width}×${campMap.image_height}`
              : t('camp_map.empty_meta', 'No image uploaded — demo placeholder shown below.')}
          </span>
        </div>

        {/* Snapshot + compare pickers — only show once we have at least one upload */}
        {snapshots.length > 0 && (
          <div className="mt-3 pt-3 border-t border-slate-700 flex flex-wrap items-center gap-3 text-xs">
            <label className="flex items-center gap-1.5 text-slate-300">
              <History size={12} className="text-ai" />
              {t('camp_map.snapshot_active', 'Snapshot')}
              <select
                value={activeId ?? ''}
                onChange={(e) => setActiveId(e.target.value || null)}
                className="bg-surface-deep border border-slate-700 rounded px-2 py-1 text-xs focus:border-brand outline-none"
              >
                {snapshots.map((s) => (
                  <option key={s.id} value={s.id}>
                    {formatSnapshotLabel(s)}
                  </option>
                ))}
              </select>
            </label>

            <label className="flex items-center gap-1.5 text-slate-300">
              <Layers size={12} className="text-ai" />
              {t('camp_map.snapshot_compare', 'Compare to')}
              <select
                value={compareId ?? ''}
                onChange={(e) => setCompareId(e.target.value || null)}
                className="bg-surface-deep border border-slate-700 rounded px-2 py-1 text-xs focus:border-brand outline-none"
              >
                <option value="">{t('camp_map.compare_none', '— none —')}</option>
                {snapshots
                  .filter((s) => s.id !== activeId)
                  .map((s) => (
                    <option key={s.id} value={s.id}>
                      {formatSnapshotLabel(s)}
                    </option>
                  ))}
              </select>
            </label>

            {diff && compareMap && (
              <span className="text-[10px] text-slate-500 ms-auto">
                {t(
                  'camp_map.diff_summary_chip',
                  '{{span}}d span · +{{added}} new · −{{removed}} gone · {{moved}} moved',
                  {
                    span: diff.span_days,
                    added: diff.added.length,
                    removed: diff.removed.length,
                    moved: diff.moved.length,
                  }
                )}
              </span>
            )}
          </div>
        )}

        {error && (
          <div className="mt-3 bg-priority-critical/10 border border-priority-critical/30 rounded-lg p-2 text-xs text-priority-critical flex items-start gap-2">
            <AlertTriangle size={14} className="flex-shrink-0 mt-0.5" />
            <span>{error}</span>
          </div>
        )}
      </Card>

      {/* ---------- Canvas + insights split ---------- */}
      {campMap ? (
        <div className="grid grid-cols-1 lg:grid-cols-[1fr_320px] gap-4">
          <CampMapCanvas
            campMap={campMap}
            imageUrl={imageUrl}
            families={families}
            mode={mode}
            onChangeMode={setMode}
            onPickTent={onPickTent}
            onAddHazardZone={onAddHazardZone}
            onAddFeature={onAddFeature}
            onDeleteFeature={onDeleteFeature}
            showSuggestions={showSuggestions}
            diff={diff}
          />
          <CampMapInsights
            campMap={campMap}
            compareMap={compareMap}
            diff={diff}
            families={families}
            history={history}
            showSuggestions={showSuggestions}
            onToggleSuggestions={setShowSuggestions}
            onSetAvgHousehold={(n) => void setAvgHouseholdSize(campMap.id, n)}
          />
        </div>
      ) : (
        <EmptyState />
      )}

      {/* ---------- Family picker modal (when pinning) ---------- */}
      {pendingTentId && (
        <FamilyPicker
          families={families.filter(
            (f) => !campMap?.family_pins.some((p) => p.family_id === f.family_id)
          )}
          onPick={onPickFamily}
          onCancel={() => setPendingTentId(null)}
        />
      )}
    </div>
  );
}

// =========================================================================
// Snapshot picker helpers
// =========================================================================

function formatSnapshotLabel(s: CampMapRow): string {
  const d = new Date(s.uploaded_at);
  const date = d.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
  const tentCount = s.features.filter((f) => f.type === 'tent').length;
  return `${date} · ${tentCount} ${tentCount === 1 ? 'tent' : 'tents'}`;
}

// =========================================================================
// Empty state (no image yet, but show the demo placeholder if present)
// =========================================================================

function EmptyState() {
  const { t } = useTranslation();
  return (
    <Card>
      <div className="text-center py-6 space-y-4">
        <ImageIcon size={36} className="mx-auto text-slate-500" />
        <h2 className="font-semibold text-slate-100">
          {t('camp_map.empty_title', 'No aerial image uploaded yet')}
        </h2>
        <p className="text-sm text-slate-400 max-w-md mx-auto">
          {t(
            'camp_map.empty_body',
            'Click "Upload aerial image" above to send a drone snapshot through Gemma 4 vision. The processed layout, family pins, and hazard zones will appear here.'
          )}
        </p>
        <img
          src={DEMO_IMAGE_PATH}
          alt={t('camp_map.demo_alt', 'Example aerial layout') as string}
          className="max-w-md mx-auto rounded-lg border border-slate-700 opacity-60"
          onError={(e) => {
            // No demo image present? Hide gracefully.
            (e.currentTarget as HTMLImageElement).style.display = 'none';
          }}
        />
        <p className="text-[10px] text-slate-500">
          {t(
            'camp_map.demo_hint',
            'Demo image — drop a real drone shot at public/screenshots/camp-map/demo.jpg to replace.'
          )}
        </p>
      </div>
    </Card>
  );
}

// =========================================================================
// Family picker — small modal opened after clicking a tent in Pin mode
// =========================================================================

function FamilyPicker({
  families,
  onPick,
  onCancel,
}: {
  families: Family[];
  onPick: (family_id: string) => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const [q, setQ] = useState('');
  const filtered = families
    .filter((f) => {
      if (!q.trim()) return true;
      const needle = q.toLowerCase();
      return (
        f.head_name.toLowerCase().includes(needle) ||
        f.family_id.toLowerCase().includes(needle)
      );
    })
    .slice(0, 100);

  return (
    <div
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4"
      onClick={onCancel}
    >
      <div
        className="w-full max-w-md bg-surface border border-slate-700 rounded-xl shadow-2xl overflow-hidden flex flex-col max-h-[80vh]"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="px-4 py-3 border-b border-slate-700 flex items-center justify-between">
          <div className="flex items-center gap-2 text-sm font-semibold">
            <Sparkles size={14} className="text-ai" />
            {t('camp_map.picker_title', 'Pin a family to this tent')}
          </div>
          <button
            onClick={onCancel}
            className="touch-target p-1.5 text-slate-400 hover:text-slate-100"
          >
            ×
          </button>
        </header>
        <div className="p-3 border-b border-slate-700">
          <input
            autoFocus
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={t('camp_map.picker_search', 'Search by name or ID…') as string}
            className="w-full bg-surface-deep border border-slate-700 rounded px-2 py-1.5 text-sm focus:border-brand outline-none"
          />
        </div>
        <div className="overflow-y-auto flex-1">
          {filtered.length === 0 ? (
            <p className="p-4 text-xs text-slate-500 text-center italic">
              {t('camp_map.picker_none', 'No matching families.')}
            </p>
          ) : (
            <ul className="divide-y divide-slate-700">
              {filtered.map((f) => (
                <li key={f.family_id}>
                  <button
                    onClick={() => onPick(f.family_id)}
                    className="touch-target w-full text-left px-3 py-2 hover:bg-surface-light flex items-center gap-3"
                  >
                    <div className="flex-1 min-w-0">
                      <div className="text-sm text-slate-100 truncate">{f.head_name}</div>
                      <div className="text-[10px] text-slate-500">
                        {f.family_id} · {f.location_sector} · {f.member_count} members
                      </div>
                    </div>
                    {f.priority_level && (
                      <span className="text-[10px] text-priority-critical">{f.priority_level}</span>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
