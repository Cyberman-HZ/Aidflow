// AidFlow Pro — Camp Map canvas.
//
// Renders the uploaded aerial image with an SVG overlay layer for every
// detected feature (tents, water, latrines, paths, open areas, buildings,
// vehicles), the admin-painted hazard polygons, and family pins.
//
// Four interaction modes (selected by the parent page):
//   - 'view'    — read-only browsing, click a tent to see pin info.
//   - 'pin'     — click a tent to attach/detach a family pin.
//   - 'hazard'  — click to add polygon vertices; double-click to close
//                 the polygon and persist it as a flood/hazard zone.
//   - 'edit'    — correct the AI's first pass: click a marker to delete
//                 it, click empty space to add a feature of the
//                 currently selected "brush" type (tent / water / etc.).
//
// Coordinates everywhere are NORMALIZED (0..1). The SVG uses a 0..1
// viewBox so the overlay scales with the image automatically.

import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Crosshair,
  Pencil,
  Eye,
  X,
  PencilLine,
  Tent,
  Droplet,
  Building2,
  Car,
  Bath,
} from 'lucide-react';
import type {
  CampFamilyPin,
  CampFeature,
  CampFeatureType,
  CampHazardZone,
  CampMap,
  Family,
} from '@/types';
import {
  buildingsOf,
  confidenceWeight,
  latrinesOf,
  openAreasOf,
  pathsOf,
  suggestedDeliveryRoutes,
  tentCentroid,
  tentsOf,
  waterPointsOf,
  weightedFamilyCentroid,
  vulnerabilityScore,
  type SnapshotDiff,
} from '@/services/campMap';

export type CanvasMode = 'view' | 'pin' | 'hazard' | 'edit';

/** Point-feature types the Edit-mode brush supports (polygons stay AI-only). */
export type EditBrushType = Extract<
  CampFeatureType,
  'tent' | 'water_point' | 'latrine' | 'building' | 'vehicle'
>;

interface Props {
  campMap: CampMap;
  imageUrl: string;
  families: Family[];
  mode: CanvasMode;
  onChangeMode: (m: CanvasMode) => void;
  onPickTent: (featureId: string) => void;
  onAddHazardZone: (zone: CampHazardZone) => void;
  /** Edit-mode callbacks. */
  onAddFeature: (f: { type: EditBrushType; x: number; y: number }) => void;
  onDeleteFeature: (featureId: string) => void;
  /** Show the suggested distribution point + delivery rays. */
  showSuggestions: boolean;
  /** Snapshot diff overlay (null when no comparison is selected). */
  diff?: SnapshotDiff | null;
}

export default function CampMapCanvas({
  campMap,
  imageUrl,
  families,
  mode,
  onChangeMode,
  onPickTent,
  onAddHazardZone,
  onAddFeature,
  onDeleteFeature,
  showSuggestions,
  diff,
}: Props) {
  const { t } = useTranslation();
  const svgRef = useRef<SVGSVGElement | null>(null);
  // In-progress hazard polygon (only meaningful when mode === 'hazard').
  const [paintPoints, setPaintPoints] = useState<Array<[number, number]>>([]);
  // Currently selected "brush" type for Edit mode (default: tent — most
  // common correction target).
  const [editBrush, setEditBrush] = useState<EditBrushType>('tent');

  // Reset paint state when we leave hazard mode.
  useEffect(() => {
    if (mode !== 'hazard') setPaintPoints([]);
  }, [mode]);

  // Pre-compute family weights so the medical-tent centroid is stable
  // across re-renders. Map by feature_id for O(1) lookup.
  const weightedPins = useMemo(() => {
    const famById = new Map(families.map((f) => [f.family_id, f] as const));
    return campMap.family_pins
      .map((p) => {
        const f = famById.get(p.family_id);
        if (!f) return null;
        return { feature_id: p.feature_id, weight: vulnerabilityScore(f, []) };
      })
      .filter((w): w is { feature_id: string; weight: number } => !!w);
  }, [campMap.family_pins, families]);

  const distributionCentroid = useMemo(() => tentCentroid(campMap.features), [campMap.features]);
  const medicalCentroid = useMemo(
    () => weightedFamilyCentroid(weightedPins, campMap.features),
    [weightedPins, campMap.features]
  );
  const routes = useMemo(
    () => (showSuggestions ? suggestedDeliveryRoutes(campMap.features) : []),
    [showSuggestions, campMap.features]
  );

  // Pin lookup so a clicked tent can show the attached family quickly.
  const pinByFeature = useMemo(() => {
    const m = new Map<string, CampFamilyPin>();
    for (const p of campMap.family_pins) m.set(p.feature_id, p);
    return m;
  }, [campMap.family_pins]);

  // Set of feature ids that the diff marked as ADDED — used to draw a
  // green ring around the corresponding regular tent marker.
  const addedTentIds = useMemo(() => {
    if (!diff) return null;
    return new Set(diff.added.map((f) => f.id));
  }, [diff]);

  // Convert a pointer event into normalized SVG coordinates.
  const eventToXY = (e: React.MouseEvent<SVGSVGElement>): [number, number] | null => {
    const svg = svgRef.current;
    if (!svg) return null;
    const rect = svg.getBoundingClientRect();
    const x = (e.clientX - rect.left) / rect.width;
    const y = (e.clientY - rect.top) / rect.height;
    if (x < 0 || x > 1 || y < 0 || y > 1) return null;
    return [Number(x.toFixed(4)), Number(y.toFixed(4))];
  };

  const onSvgClick = (e: React.MouseEvent<SVGSVGElement>) => {
    if (mode === 'hazard') {
      const pt = eventToXY(e);
      if (!pt) return;
      setPaintPoints((p) => [...p, pt]);
      return;
    }
    if (mode === 'edit') {
      // Clicks that bubble up from a feature marker call stopPropagation,
      // so reaching this handler means the user clicked empty space —
      // add a new feature of the current brush type.
      const pt = eventToXY(e);
      if (!pt) return;
      onAddFeature({ type: editBrush, x: pt[0], y: pt[1] });
    }
  };

  const onSvgDoubleClick = (e: React.MouseEvent<SVGSVGElement>) => {
    if (mode !== 'hazard') return;
    e.preventDefault();
    if (paintPoints.length >= 3) {
      const zone: CampHazardZone = {
        id: `hz-${Date.now()}`,
        kind: 'flood',
        label: t('camp_map.hazard_default_label', 'Flood-risk zone') ?? 'Flood-risk zone',
        polygon: paintPoints,
        created_at: new Date().toISOString(),
      };
      onAddHazardZone(zone);
      setPaintPoints([]);
      onChangeMode('view');
    } else {
      setPaintPoints([]);
    }
  };

  return (
    <div className="relative">
      {/* Mode toolbar */}
      <div className="absolute top-2 left-2 z-10 flex gap-1 bg-surface-deep/80 backdrop-blur rounded-lg p-1 border border-slate-700">
        <ModeButton
          icon={<Eye size={14} />}
          label={t('camp_map.mode_view', 'View')}
          active={mode === 'view'}
          onClick={() => onChangeMode('view')}
        />
        <ModeButton
          icon={<Crosshair size={14} />}
          label={t('camp_map.mode_pin', 'Pin families')}
          active={mode === 'pin'}
          onClick={() => onChangeMode('pin')}
        />
        <ModeButton
          icon={<PencilLine size={14} />}
          label={t('camp_map.mode_edit', 'Edit features')}
          active={mode === 'edit'}
          onClick={() => onChangeMode('edit')}
        />
        <ModeButton
          icon={<Pencil size={14} />}
          label={t('camp_map.mode_hazard', 'Paint hazard zone')}
          active={mode === 'hazard'}
          onClick={() => onChangeMode('hazard')}
        />
      </div>
      {mode === 'edit' && (
        <div className="absolute top-2 right-2 z-10 max-w-sm bg-surface-deep/85 backdrop-blur border border-slate-700 rounded-lg p-2 flex flex-col gap-1.5">
          <div className="text-[10px] text-slate-400 leading-snug">
            {t(
              'camp_map.edit_hint',
              'Click a marker to delete it. Click empty space to add a feature of the selected type.'
            )}
          </div>
          <div className="flex flex-wrap gap-1">
            <BrushButton
              icon={<Tent size={12} />}
              label={t('camp_map.brush_tent', 'Tent')}
              active={editBrush === 'tent'}
              onClick={() => setEditBrush('tent')}
            />
            <BrushButton
              icon={<Droplet size={12} />}
              label={t('camp_map.brush_water', 'Water')}
              active={editBrush === 'water_point'}
              onClick={() => setEditBrush('water_point')}
            />
            <BrushButton
              icon={<Bath size={12} />}
              label={t('camp_map.brush_latrine', 'Latrine')}
              active={editBrush === 'latrine'}
              onClick={() => setEditBrush('latrine')}
            />
            <BrushButton
              icon={<Building2 size={12} />}
              label={t('camp_map.brush_building', 'Building')}
              active={editBrush === 'building'}
              onClick={() => setEditBrush('building')}
            />
            <BrushButton
              icon={<Car size={12} />}
              label={t('camp_map.brush_vehicle', 'Vehicle')}
              active={editBrush === 'vehicle'}
              onClick={() => setEditBrush('vehicle')}
            />
          </div>
        </div>
      )}
      {mode === 'hazard' && (
        <div className="absolute top-2 right-2 z-10 max-w-xs bg-priority-medium/15 border border-priority-medium/40 rounded-lg px-3 py-2 text-xs text-priority-medium">
          {t(
            'camp_map.hazard_hint',
            'Click to add polygon vertices. Double-click to save the zone (needs at least 3 points).'
          )}
          {paintPoints.length > 0 && (
            <button
              className="ms-2 underline text-priority-medium hover:no-underline"
              onClick={() => setPaintPoints([])}
            >
              <X size={11} className="inline" /> {t('camp_map.hazard_clear', 'reset')}
            </button>
          )}
        </div>
      )}

      <div className="relative w-full">
        <img
          src={imageUrl}
          alt={t('camp_map.image_alt', 'Aerial camp image') as string}
          className="w-full h-auto block rounded-lg border border-slate-700"
          draggable={false}
        />
        <svg
          ref={svgRef}
          viewBox="0 0 1 1"
          preserveAspectRatio="none"
          className={`absolute inset-0 w-full h-full ${
            mode === 'hazard'
              ? 'cursor-crosshair'
              : mode === 'edit'
              ? 'cursor-copy'
              : 'cursor-default'
          }`}
          onClick={onSvgClick}
          onDoubleClick={onSvgDoubleClick}
        >
          {/* Hazard zones (rendered first so features draw on top) */}
          {campMap.hazard_zones.map((z) => (
            <HazardOverlay key={z.id} zone={z} />
          ))}
          {/* In-progress hazard polygon */}
          {mode === 'hazard' && paintPoints.length > 0 && (
            <PolyLineOrPolygon points={paintPoints} closed={false} className="stroke-priority-medium fill-priority-medium/20" />
          )}

          {/* Open areas (large, faded) */}
          {openAreasOf(campMap.features).map((f) =>
            f.polygon ? (
              <PolyLineOrPolygon
                key={f.id}
                points={f.polygon}
                closed
                className="stroke-priority-normal/60 fill-priority-normal/10"
                strokeWidth={0.003}
              />
            ) : null
          )}

          {/* Paths */}
          {pathsOf(campMap.features).map((f) =>
            f.polyline ? (
              <PolyLineOrPolygon
                key={f.id}
                points={f.polyline}
                closed={false}
                className="stroke-amber-400/70"
                strokeWidth={0.0035}
                dashed
              />
            ) : null
          )}

          {/* Delivery route hints (when suggestions on) */}
          {routes.map((r, i) => (
            <line
              key={`route-${i}`}
              x1={r.from.x}
              y1={r.from.y}
              x2={r.to.x}
              y2={r.to.y}
              strokeWidth={0.0015}
              className="stroke-ai/40"
              strokeDasharray="0.006 0.006"
            />
          ))}

          {/* Diff overlay — removed tents from the compare snapshot */}
          {diff?.removed.map((f, i) =>
            typeof f.x === 'number' && typeof f.y === 'number' ? (
              <circle
                key={`diff-removed-${i}`}
                cx={f.x}
                cy={f.y}
                r={0.009}
                strokeWidth={0.0025}
                strokeDasharray="0.005 0.004"
                className="stroke-priority-critical fill-priority-critical/15"
              >
                <title>Tent no longer present (was here on the compare snapshot)</title>
              </circle>
            ) : null
          )}

          {/* Diff overlay — moved-tent arrows (compare → active) */}
          {diff?.moved.map((m, i) =>
            typeof m.a.x === 'number' &&
            typeof m.a.y === 'number' &&
            typeof m.b.x === 'number' &&
            typeof m.b.y === 'number' ? (
              <line
                key={`diff-moved-${i}`}
                x1={m.b.x}
                y1={m.b.y}
                x2={m.a.x}
                y2={m.a.y}
                strokeWidth={0.002}
                className="stroke-amber-300/90"
              >
                <title>Tent moved {(m.distance * 100).toFixed(1)}% of the image span</title>
              </line>
            ) : null
          )}

          {/* Buildings */}
          {buildingsOf(campMap.features).map((f) =>
            typeof f.x === 'number' && typeof f.y === 'number' ? (
              <FeatureMarker
                key={f.id}
                x={f.x}
                y={f.y}
                radius={0.012}
                className="fill-cyan-500/70 stroke-cyan-300"
                opacity={confidenceWeight(f.confidence)}
                tooltip={`${f.type}${f.label ? `: ${f.label}` : ''} (${f.confidence ?? '?'})`}
                onClick={
                  mode === 'edit'
                    ? (e: React.MouseEvent) => {
                        e.stopPropagation();
                        onDeleteFeature(f.id);
                      }
                    : undefined
                }
                cursor={mode === 'edit' ? 'pointer' : undefined}
              />
            ) : null
          )}
          {/* Latrines */}
          {latrinesOf(campMap.features).map((f) =>
            typeof f.x === 'number' && typeof f.y === 'number' ? (
              <FeatureMarker
                key={f.id}
                x={f.x}
                y={f.y}
                radius={0.008}
                className="fill-amber-700/80 stroke-amber-300"
                opacity={confidenceWeight(f.confidence)}
                tooltip={`latrine (${f.confidence ?? '?'})`}
                onClick={
                  mode === 'edit'
                    ? (e: React.MouseEvent) => {
                        e.stopPropagation();
                        onDeleteFeature(f.id);
                      }
                    : undefined
                }
                cursor={mode === 'edit' ? 'pointer' : undefined}
              />
            ) : null
          )}
          {/* Water points */}
          {waterPointsOf(campMap.features).map((f) =>
            typeof f.x === 'number' && typeof f.y === 'number' ? (
              <FeatureMarker
                key={f.id}
                x={f.x}
                y={f.y}
                radius={0.009}
                className="fill-sky-500/85 stroke-sky-200"
                opacity={confidenceWeight(f.confidence)}
                tooltip={`water point (${f.confidence ?? '?'})`}
                onClick={
                  mode === 'edit'
                    ? (e: React.MouseEvent) => {
                        e.stopPropagation();
                        onDeleteFeature(f.id);
                      }
                    : undefined
                }
                cursor={mode === 'edit' ? 'pointer' : undefined}
              />
            ) : null
          )}
          {/* Tents — interactive in pin mode (pick) and edit mode (delete) */}
          {tentsOf(campMap.features).map((f) => {
            if (typeof f.x !== 'number' || typeof f.y !== 'number') return null;
            const isAdded = addedTentIds?.has(f.id) ?? false;
            return (
              <g key={f.id}>
                {/* Outer green ring marking a newly-arrived tent in compare mode */}
                {isAdded && (
                  <circle
                    cx={f.x}
                    cy={f.y}
                    r={0.011}
                    strokeWidth={0.002}
                    className="stroke-priority-normal fill-priority-normal/10"
                  >
                    <title>New tent since the compare snapshot</title>
                  </circle>
                )}
                <FeatureMarker
                  x={f.x}
                  y={f.y}
                  radius={0.0065}
                  className={`${
                    pinByFeature.has(f.id)
                      ? 'fill-priority-critical/90 stroke-priority-critical'
                      : 'fill-emerald-500/80 stroke-emerald-200'
                  } ${mode === 'pin' || mode === 'edit' ? 'cursor-pointer' : ''}`}
                  opacity={confidenceWeight(f.confidence)}
                  tooltip={
                    pinByFeature.has(f.id)
                      ? `${f.id} → ${pinByFeature.get(f.id)?.family_id}`
                      : `${f.id} (${f.confidence ?? '?'})${isAdded ? ' · new' : ''}`
                  }
                  onClick={
                    mode === 'pin'
                      ? (e: React.MouseEvent) => {
                          e.stopPropagation();
                          onPickTent(f.id);
                        }
                      : mode === 'edit'
                      ? (e: React.MouseEvent) => {
                          e.stopPropagation();
                          onDeleteFeature(f.id);
                        }
                      : undefined
                  }
                />
              </g>
            );
          })}

          {/* Suggestion markers */}
          {showSuggestions && distributionCentroid && (
            <SuggestionStar x={distributionCentroid.x} y={distributionCentroid.y} kind="distribution" />
          )}
          {showSuggestions && medicalCentroid && (
            <SuggestionStar x={medicalCentroid.x} y={medicalCentroid.y} kind="medical" />
          )}
        </svg>
      </div>
    </div>
  );
}

// =========================================================================
// Small SVG building blocks
// =========================================================================

function ModeButton({
  icon,
  label,
  active,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      className={`touch-target px-2 py-1 rounded text-xs flex items-center gap-1 ${
        active
          ? 'bg-ai text-white font-semibold'
          : 'text-slate-300 hover:bg-surface-light hover:text-white'
      }`}
    >
      {icon}
      <span className="hidden sm:inline">{label}</span>
    </button>
  );
}

function FeatureMarker({
  x,
  y,
  radius,
  className,
  tooltip,
  onClick,
  opacity,
  cursor,
}: {
  x: number;
  y: number;
  radius: number;
  className: string;
  tooltip?: string;
  onClick?: (e: React.MouseEvent) => void;
  opacity?: number;
  cursor?: string;
}) {
  return (
    <circle
      cx={x}
      cy={y}
      r={radius}
      strokeWidth={radius * 0.25}
      className={className}
      opacity={opacity}
      style={cursor ? { cursor } : undefined}
      onClick={onClick}
    >
      {tooltip && <title>{tooltip}</title>}
    </circle>
  );
}

function BrushButton({
  icon,
  label,
  active,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      className={`touch-target px-1.5 py-1 rounded text-[10px] flex items-center gap-1 ${
        active
          ? 'bg-ai text-white font-semibold'
          : 'text-slate-300 hover:bg-surface-light hover:text-white'
      }`}
    >
      {icon}
      {label}
    </button>
  );
}

function PolyLineOrPolygon({
  points,
  closed,
  className,
  strokeWidth = 0.0025,
  dashed = false,
}: {
  points: ReadonlyArray<readonly [number, number]>;
  closed: boolean;
  className: string;
  strokeWidth?: number;
  dashed?: boolean;
}) {
  const d = points.map(([x, y]) => `${x},${y}`).join(' ');
  if (closed) {
    return (
      <polygon
        points={d}
        strokeWidth={strokeWidth}
        className={className}
        strokeDasharray={dashed ? '0.005 0.005' : undefined}
      />
    );
  }
  return (
    <polyline
      points={d}
      fill="none"
      strokeWidth={strokeWidth}
      className={className}
      strokeDasharray={dashed ? '0.005 0.005' : undefined}
    />
  );
}

function HazardOverlay({ zone }: { zone: CampHazardZone }) {
  const d = zone.polygon.map(([x, y]) => `${x},${y}`).join(' ');
  return (
    <polygon
      points={d}
      strokeWidth={0.003}
      className="stroke-priority-critical/80 fill-priority-critical/15"
    >
      <title>{zone.label ?? zone.kind}</title>
    </polygon>
  );
}

function SuggestionStar({ x, y, kind }: { x: number; y: number; kind: 'distribution' | 'medical' }) {
  const isMedical = kind === 'medical';
  const fill = isMedical ? 'fill-pink-500/95' : 'fill-ai';
  const stroke = isMedical ? 'stroke-pink-200' : 'stroke-white';
  const r = 0.018;
  // 5-point star path centred at (x, y) in normalized coords.
  const pts: string[] = [];
  for (let i = 0; i < 10; i++) {
    const angle = (Math.PI / 5) * i - Math.PI / 2;
    const radius = i % 2 === 0 ? r : r * 0.45;
    pts.push(`${x + radius * Math.cos(angle)},${y + radius * Math.sin(angle)}`);
  }
  return (
    <polygon
      points={pts.join(' ')}
      strokeWidth={0.0025}
      className={`${fill} ${stroke}`}
    >
      <title>{isMedical ? 'Suggested medical / nutrition tent' : 'Suggested distribution point'}</title>
    </polygon>
  );
}
