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
} from 'lucide-react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '@/db/database';
import { Card } from '@/components/Card';
import CampMapCanvas, { type CanvasMode } from '@/components/CampMapCanvas';
import CampMapInsights from '@/components/CampMapInsights';
import TraceButton from '@/components/TraceButton';
import {
  analyzeAndStoreImage,
  clearCurrentCampMap,
  getCurrentCampMap,
  setAvgHouseholdSize,
  setFamilyPins,
  setHazardZones,
} from '@/services/campMap';
import type { CampFamilyPin, CampHazardZone, Family } from '@/types';
import { useAuthStore } from '@/stores/authStore';
import { useSettingsStore } from '@/stores/settingsStore';

const DEMO_IMAGE_PATH = '/screenshots/camp-map/demo.jpg';

export default function CampMap() {
  const { t } = useTranslation();
  const user = useAuthStore((s) => s.user);
  const language = useSettingsStore((s) => s.language);

  const campMap = useLiveQuery(() => getCurrentCampMap(), []);
  const families = useLiveQuery(
    () => db.families.toArray().then((rows) => rows.filter((f) => !f.deleted_at)),
    []
  ) ?? ([] as Family[]);
  const history = useLiveQuery(() => db.distributions.toArray(), []) ?? [];

  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<CanvasMode>('view');
  const [showSuggestions, setShowSuggestions] = useState(true);
  // Family-pin "click a tent then pick a family" sub-flow.
  const [pendingTentId, setPendingTentId] = useState<string | null>(null);

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
      await analyzeAndStoreImage(file, {
        uploaded_by: user.user_id,
        language,
        source_kind: 'drone',
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setUploading(false);
    }
  };

  const onClear = async () => {
    if (!confirm(
      t('camp_map.confirm_clear', 'Remove the current camp map? Family pins and hazard zones will be lost too.') as string
    )) return;
    await clearCurrentCampMap();
    setMode('view');
    setPendingTentId(null);
  };

  const onPickTent = (featureId: string) => {
    if (!campMap) return;
    // If a pin already exists for this tent, toggle it off; otherwise
    // queue it and open the family picker.
    const existing = campMap.family_pins.find((p) => p.feature_id === featureId);
    if (existing) {
      void setFamilyPins(campMap.family_pins.filter((p) => p.feature_id !== featureId));
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
    void setFamilyPins(next);
    setPendingTentId(null);
  };

  const onAddHazardZone = (zone: CampHazardZone) => {
    if (!campMap) return;
    void setHazardZones([...campMap.hazard_zones, zone]);
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
              onClick={() => void onClear()}
              disabled={uploading}
              className="touch-target px-3 py-2 text-xs text-priority-critical hover:underline flex items-center gap-1"
            >
              <Trash2 size={12} />
              {t('camp_map.clear', 'Clear map')}
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
            showSuggestions={showSuggestions}
          />
          <CampMapInsights
            campMap={campMap}
            families={families}
            history={history}
            showSuggestions={showSuggestions}
            onToggleSuggestions={setShowSuggestions}
            onSetAvgHousehold={(n) => void setAvgHouseholdSize(n)}
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
