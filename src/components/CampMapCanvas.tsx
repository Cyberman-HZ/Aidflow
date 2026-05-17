// AidFlow Pro — Camp Map canvas.
//
// Renders the uploaded aerial image with an SVG overlay layer for every
// detected feature (tents, water, latrines, paths, open areas, buildings,
// vehicles), the admin-painted hazard polygons, and family pins.
//
// Three interaction modes (selected by the parent page):
//   - 'view'    — read-only browsing, click a tent to see pin info.
//   - 'pin'     — click a tent to attach/detach a family pin.
//   - 'hazard'  — click to add polygon vertices; double-click to close
//                 the polygon and persist it as a flood/hazard zone.
//
// Coordinates everywhere are NORMALIZED (0..1). The SVG uses a 0..1
// viewBox so the overlay scales with the image automatically.

import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Crosshair, Pencil, Eye, X } from 'lucide-react';
import type {
  CampFamilyPin,
  CampFeature,
  CampHazardZone,
  CampMap,
  Family,
} from '@/types';
import {
  buildingsOf,
  latrinesOf,
  openAreasOf,
  pathsOf,
  suggestedDeliveryRoutes,
  tentCentroid,
  tentsOf,
  waterPointsOf,
  weightedFamilyCentroid,
  vulnerabilityScore,
} from '@/services/campMap';

export type CanvasMode = 'view' | 'pin' | 'hazard';

interface Props {
  campMap: CampMap;
  imageUrl: string;
  families: Family[];
  mode: CanvasMode;
  onChangeMode: (m: CanvasMode) => void;
  onPickTent: (featureId: string) => void;
  onAddHazardZone: (zone: CampHazardZone) => void;
  /** Show the suggested distribution point + delivery rays. */
  showSuggestions: boolean;
}

export default function CampMapCanvas({
  campMap,
  imageUrl,
  families,
  mode,
  onChangeMode,
  onPickTent,
  onAddHazardZone,
  showSuggestions,
}: Props) {
  const { t } = useTranslation();
  const svgRef = useRef<SVGSVGElement | null>(null);
  // In-progress hazard polygon (only meaningful when mode === 'hazard').
  const [paintPoints, setPaintPoints] = useState<Array<[number, number]>>([]);

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
    if (mode !== 'hazard') return;
    const pt = eventToXY(e);
    if (!pt) return;
    setPaintPoints((p) => [...p, pt]);
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
          icon={<Pencil size={14} />}
          label={t('camp_map.mode_hazard', 'Paint hazard zone')}
          active={mode === 'hazard'}
          onClick={() => onChangeMode('hazard')}
        />
      </div>
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
            mode === 'hazard' ? 'cursor-crosshair' : 'cursor-default'
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

          {/* Buildings */}
          {buildingsOf(campMap.features).map((f) =>
            typeof f.x === 'number' && typeof f.y === 'number' ? (
              <FeatureMarker
                key={f.id}
                x={f.x}
                y={f.y}
                radius={0.012}
                className="fill-cyan-500/70 stroke-cyan-300"
                tooltip={`${f.type}${f.label ? `: ${f.label}` : ''} (${f.confidence ?? '?'})`}
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
                tooltip={`latrine (${f.confidence ?? '?'})`}
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
                tooltip={`water point (${f.confidence ?? '?'})`}
              />
            ) : null
          )}
          {/* Tents — interactive in pin mode */}
          {tentsOf(campMap.features).map((f) =>
            typeof f.x === 'number' && typeof f.y === 'number' ? (
              <FeatureMarker
                key={f.id}
                x={f.x}
                y={f.y}
                radius={0.0065}
                className={`${
                  pinByFeature.has(f.id)
                    ? 'fill-priority-critical/90 stroke-priority-critical'
                    : 'fill-emerald-500/80 stroke-emerald-200'
                } ${mode === 'pin' ? 'cursor-pointer' : ''}`}
                tooltip={
                  pinByFeature.has(f.id)
                    ? `${f.id} → ${pinByFeature.get(f.id)?.family_id}`
                    : f.id
                }
                onClick={
                  mode === 'pin'
                    ? (e: React.MouseEvent) => {
                        e.stopPropagation();
                        onPickTent(f.id);
                      }
                    : undefined
                }
              />
            ) : null
          )}

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
}: {
  x: number;
  y: number;
  radius: number;
  className: string;
  tooltip?: string;
  onClick?: (e: React.MouseEvent) => void;
}) {
  return (
    <circle
      cx={x}
      cy={y}
      r={radius}
      strokeWidth={radius * 0.25}
      className={className}
      onClick={onClick}
    >
      {tooltip && <title>{tooltip}</title>}
    </circle>
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
