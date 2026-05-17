// AidFlow Pro — Camp Map insights panel (right-rail tasks).
//
// Computes the 9 operational tasks the user asked for, in cards small
// enough to fit beside the canvas. Each card binds to a piece of state
// the canvas can react to (e.g. clicking "Suggest distribution point"
// triggers the star marker to appear on the canvas).

import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Users,
  Crosshair,
  Droplet,
  Hospital,
  Map as MapIcon,
  Activity,
  UserPlus,
  Shield,
  AlertTriangle,
  CheckCircle2,
  Info,
  TrendingUp,
} from 'lucide-react';
import type { AidDistribution, CampMap, Family } from '@/types';
import {
  estimatePopulation,
  sphereReport,
  tentCentroid,
  tentsInHazardZones,
  underservedZones,
  unregisteredEstimate,
  weightedFamilyCentroid,
  vulnerabilityScore,
  openAreasOf,
  pathsOf,
  buildingsOf,
  type SnapshotDiff,
} from '@/services/campMap';

interface Props {
  campMap: CampMap;
  /** Older snapshot we're diffing against, or null if no comparison is on. */
  compareMap: CampMap | null;
  diff: SnapshotDiff | null;
  families: Family[];
  history: AidDistribution[];
  showSuggestions: boolean;
  onToggleSuggestions: (on: boolean) => void;
  onSetAvgHousehold: (n: number) => void;
}

export default function CampMapInsights({
  campMap,
  compareMap,
  diff,
  families,
  history,
  showSuggestions,
  onToggleSuggestions,
  onSetAvgHousehold,
}: Props) {
  const { t } = useTranslation();
  const avg = campMap.avg_household_size ?? 5;

  // Pre-compute all derived numbers in one pass.
  const pop = useMemo(
    () => estimatePopulation(campMap.features, avg),
    [campMap.features, avg]
  );
  const sphere = useMemo(
    () => sphereReport(campMap.features, avg),
    [campMap.features, avg]
  );
  const unreg = useMemo(
    () => unregisteredEstimate(campMap.features, families),
    [campMap.features, families]
  );
  const distCentroid = useMemo(() => tentCentroid(campMap.features), [campMap.features]);
  const weightedPins = useMemo(() => {
    const famById = new Map(families.map((f) => [f.family_id, f] as const));
    return campMap.family_pins
      .map((p) => {
        const f = famById.get(p.family_id);
        if (!f) return null;
        return { feature_id: p.feature_id, weight: vulnerabilityScore(f, history) };
      })
      .filter((w): w is { feature_id: string; weight: number } => !!w);
  }, [campMap.family_pins, families, history]);
  const medCentroid = useMemo(
    () => weightedFamilyCentroid(weightedPins, campMap.features),
    [weightedPins, campMap.features]
  );
  const underserved = useMemo(
    () => underservedZones(campMap.features, campMap.family_pins, families),
    [campMap.features, campMap.family_pins, families]
  );
  const atRiskTents = useMemo(
    () => tentsInHazardZones(campMap.features, campMap.hazard_zones),
    [campMap.features, campMap.hazard_zones]
  );
  const openAreaCount = openAreasOf(campMap.features).length;
  const pathCount = pathsOf(campMap.features).length;
  const buildingCount = buildingsOf(campMap.features).length;

  // Snapshot-comparison numbers — only meaningful when diff != null
  const comparePop = useMemo(
    () => (compareMap ? estimatePopulation(compareMap.features, avg) : null),
    [compareMap, avg]
  );
  const deltaPop = comparePop ? pop.population - comparePop.population : 0;
  const deltaTents = comparePop ? pop.tents_raw - comparePop.tents_raw : 0;
  const tentsPerDay =
    diff && diff.span_days > 0 ? (deltaTents / diff.span_days).toFixed(2) : null;

  return (
    <aside className="space-y-3">
      {/* Suggestions toggle (drives the canvas star markers) */}
      <div className="flex items-center justify-between gap-2 bg-surface-light/40 border border-slate-700 rounded-lg px-3 py-2">
        <label className="flex items-center gap-2 text-xs text-slate-300 cursor-pointer">
          <input
            type="checkbox"
            checked={showSuggestions}
            onChange={(e) => onToggleSuggestions(e.target.checked)}
            className="accent-ai"
          />
          {t('camp_map.show_suggestions', 'Show suggested placements + routes')}
        </label>
      </div>

      {/* Snapshot comparison summary — only present when a compare map is set */}
      {diff && compareMap && (
        <Card
          icon={<TrendingUp size={14} className="text-ai" />}
          title={t('camp_map.card_diff', 'Snapshot comparison')}
          body={
            <div className="space-y-1.5 text-xs text-slate-300">
              <p className="text-[10px] text-slate-500">
                {t('camp_map.diff_span', '{{n}} day(s) between snapshots.', {
                  n: diff.span_days,
                })}
              </p>
              <ul className="space-y-1">
                <li className="flex items-center gap-1.5">
                  <span className="inline-block w-2 h-2 rounded-full bg-priority-normal" />
                  <span>
                    {diff.added.length} {t('camp_map.diff_added', 'new tent(s)')}
                  </span>
                </li>
                <li className="flex items-center gap-1.5">
                  <span className="inline-block w-2 h-2 rounded-full bg-priority-critical" />
                  <span>
                    {diff.removed.length} {t('camp_map.diff_removed', 'gone since')}
                  </span>
                </li>
                <li className="flex items-center gap-1.5">
                  <span className="inline-block w-2 h-2 rounded-full bg-amber-300" />
                  <span>
                    {diff.moved.length} {t('camp_map.diff_moved', 'moved')}
                  </span>
                </li>
                <li className="flex items-center gap-1.5 text-slate-400">
                  <span className="inline-block w-2 h-2 rounded-full bg-slate-500" />
                  <span>
                    {diff.kept.length} {t('camp_map.diff_kept', 'unchanged')}
                  </span>
                </li>
              </ul>
              <p className="text-[11px] text-slate-300 pt-1 border-t border-slate-700">
                {t('camp_map.diff_delta_tents', 'Δ tents')}:{' '}
                <span
                  className={
                    deltaTents > 0
                      ? 'text-priority-normal font-semibold'
                      : deltaTents < 0
                      ? 'text-priority-critical font-semibold'
                      : 'text-slate-400'
                  }
                >
                  {deltaTents > 0 ? '+' : ''}
                  {deltaTents}
                </span>
                {' · '}
                {t('camp_map.diff_delta_pop', 'Δ pop')}:{' '}
                <span
                  className={
                    deltaPop > 0
                      ? 'text-priority-normal font-semibold'
                      : deltaPop < 0
                      ? 'text-priority-critical font-semibold'
                      : 'text-slate-400'
                  }
                >
                  {deltaPop > 0 ? '+' : ''}
                  {deltaPop.toLocaleString()}
                </span>
                {tentsPerDay !== null && (
                  <>
                    {' · '}
                    {t('camp_map.diff_rate', '{{rate}} tents/day', { rate: tentsPerDay })}
                  </>
                )}
              </p>
              <p className="text-[10px] text-slate-500">
                {t(
                  'camp_map.diff_baseline',
                  'Baseline: {{date}} ({{count}} tent(s))',
                  {
                    date: new Date(compareMap.uploaded_at).toLocaleDateString(),
                    count: comparePop?.tents_raw ?? 0,
                  }
                )}
              </p>
            </div>
          }
        />
      )}

      {/* Task 1 — Population estimate */}
      <Card
        icon={<Users size={14} className="text-ai" />}
        title={t('camp_map.card_pop', 'Population estimate')}
        body={
          <>
            <Big>{pop.population.toLocaleString()}</Big>
            <p className="text-xs text-slate-400">
              {pop.tents_raw.toLocaleString()}{' '}
              {t('camp_map.tents_visible', 'tents visible')} ×{' '}
              <label className="inline-flex items-center gap-1">
                <input
                  type="number"
                  min={1}
                  max={20}
                  value={avg}
                  onChange={(e) => onSetAvgHousehold(Math.max(1, Math.floor(Number(e.target.value) || 1)))}
                  className="w-12 bg-surface-deep border border-slate-700 rounded px-1 py-0.5 text-xs text-center"
                />
                {t('camp_map.avg_household', 'avg / household')}
              </label>
              .
            </p>
            {pop.tents_raw !== pop.tents && (
              <p className="text-[10px] text-slate-500 mt-1">
                {t(
                  'camp_map.tents_weighted_note',
                  'Counted as {{n}} after confidence weighting (low-confidence tents at 0.4×).',
                  { n: pop.tents }
                )}
              </p>
            )}
          </>
        }
      />

      {/* Task 2 — Distribution point centroid */}
      <Card
        icon={<Crosshair size={14} className="text-ai" />}
        title={t('camp_map.card_dist', 'Distribution point')}
        body={
          distCentroid ? (
            <>
              <p className="text-xs text-slate-300">
                {t(
                  'camp_map.dist_body',
                  'Suggested centre = geometric centroid of all visible tents. Toggle suggestions to see the star marker on the canvas.'
                )}
              </p>
              <p className="text-[10px] text-slate-500 mt-1">
                ({distCentroid.x.toFixed(2)}, {distCentroid.y.toFixed(2)})
              </p>
            </>
          ) : (
            <p className="text-xs text-slate-500 italic">
              {t('camp_map.no_tents', 'No tents detected yet.')}
            </p>
          )
        }
      />

      {/* Task 3 — Sphere ratios (latrines + water points) */}
      <Card
        icon={<Droplet size={14} className="text-ai" />}
        title={t('camp_map.card_sphere', 'Sphere ratios')}
        body={
          <ul className="text-xs space-y-1 text-slate-300">
            <li className="flex items-center gap-1.5">
              {sphere.latrine_ok ? (
                <CheckCircle2 size={12} className="text-priority-normal" />
              ) : (
                <AlertTriangle size={12} className="text-priority-medium" />
              )}
              <span>
                {sphere.latrines} {t('camp_map.latrines', 'latrines')} →{' '}
                {sphere.latrine_ratio == null
                  ? '∞'
                  : Math.round(sphere.latrine_ratio)}{' '}
                {t('camp_map.people_per', 'people each')}
                {sphere.latrine_gap > 0 && (
                  <span className="text-priority-medium">
                    {' '}
                    ({t('camp_map.need_n_more', { count: sphere.latrine_gap, defaultValue: `need ${sphere.latrine_gap} more` })})
                  </span>
                )}
              </span>
            </li>
            <li className="flex items-center gap-1.5">
              {sphere.water_ok ? (
                <CheckCircle2 size={12} className="text-priority-normal" />
              ) : (
                <AlertTriangle size={12} className="text-priority-medium" />
              )}
              <span>
                {sphere.water_points} {t('camp_map.water_points', 'water points')} →{' '}
                {sphere.water_ratio == null
                  ? '∞'
                  : Math.round(sphere.water_ratio)}{' '}
                {t('camp_map.people_per', 'people each')}
                {sphere.water_gap > 0 && (
                  <span className="text-priority-medium">
                    {' '}
                    ({t('camp_map.need_n_more', { count: sphere.water_gap, defaultValue: `need ${sphere.water_gap} more` })})
                  </span>
                )}
              </span>
            </li>
            <li className="text-[10px] text-slate-500 mt-1">
              {t(
                'camp_map.sphere_note',
                'Sphere 2018 minimums: 1 latrine / 20 people, 1 water point / 250 people.'
              )}
            </li>
          </ul>
        }
      />

      {/* Task 4 — Medical / nutrition tent suggestion */}
      <Card
        icon={<Hospital size={14} className="text-ai" />}
        title={t('camp_map.card_med', 'Medical / nutrition tent')}
        body={
          medCentroid ? (
            <>
              <p className="text-xs text-slate-300">
                {t(
                  'camp_map.med_body',
                  'Suggested location weighted by family vulnerability (children<5, elderly, pregnant, medical conditions, recency of last aid).'
                )}
              </p>
              <p className="text-[10px] text-slate-500 mt-1">
                {weightedPins.length} {t('camp_map.pinned_families', 'pinned families considered')}.
              </p>
            </>
          ) : (
            <p className="text-xs text-slate-500 italic">
              {t(
                'camp_map.med_empty',
                'Pin at least one family on the canvas (use Pin mode) to compute a vulnerability-weighted suggestion.'
              )}
            </p>
          )
        }
      />

      {/* Task 5 — Route hints */}
      <Card
        icon={<MapIcon size={14} className="text-ai" />}
        title={t('camp_map.card_routes', 'Delivery route hints')}
        body={
          <p className="text-xs text-slate-300">
            {t(
              'camp_map.routes_body',
              'Toggle suggestions to draw lines from the distribution point to every tent. {{n}} visible paths detected so far.',
              { n: pathCount }
            )}
          </p>
        }
      />

      {/* Task 6 — Underserved zones */}
      <Card
        icon={<Activity size={14} className="text-ai" />}
        title={t('camp_map.card_underserved', 'Underserved zones')}
        body={
          underserved.length === 0 ? (
            <p className="text-xs text-slate-500 italic">
              {t(
                'camp_map.under_empty',
                'Pin families to tents so last-aid recency can be aggregated per zone.'
              )}
            </p>
          ) : (
            <ul className="text-xs space-y-1 text-slate-300">
              {underserved
                .slice()
                .sort((a, b) => b.oldest_days - a.oldest_days)
                .slice(0, 4)
                .map((z, i) => (
                  <li key={i} className="flex items-center gap-1.5">
                    <span className="text-[10px] text-slate-500 w-12">
                      ({z.cell_x},{z.cell_y})
                    </span>
                    <span>
                      {z.family_count}{' '}
                      {t('camp_map.families_short', 'families')} ·{' '}
                      <span
                        className={
                          z.oldest_days > 14
                            ? 'text-priority-critical'
                            : z.oldest_days > 7
                            ? 'text-priority-medium'
                            : 'text-priority-normal'
                        }
                      >
                        {t('camp_map.oldest_days', '{{n}}d oldest', { n: z.oldest_days })}
                      </span>
                    </span>
                  </li>
                ))}
            </ul>
          )
        }
      />

      {/* Task 7 — Unregistered arrivals */}
      <Card
        icon={<UserPlus size={14} className="text-ai" />}
        title={t('camp_map.card_unreg', 'Unregistered arrivals')}
        body={
          <>
            <p className="text-xs text-slate-300">
              {unreg.direction === 'unregistered' &&
                t('camp_map.unreg_body_more', {
                  delta: unreg.delta,
                  defaultValue: `{{delta}} more tents than registered families — possible unregistered arrivals to canvas.`,
                })}
              {unreg.direction === 'over' &&
                t('camp_map.unreg_body_less', {
                  delta: unreg.delta,
                  defaultValue: `{{delta}} more registered families than tents visible — some tents may be hidden, or registrations may overlap.`,
                })}
              {unreg.direction === 'matched' &&
                t('camp_map.unreg_body_match', 'Tent count matches registered family count.')}
            </p>
            <p className="text-[10px] text-slate-500 mt-1">
              {unreg.tent_count} {t('camp_map.tents_short', 'tents')} ·{' '}
              {unreg.registered} {t('camp_map.registered_short', 'registered')}
            </p>
          </>
        }
      />

      {/* Task 8 — Evacuation analysis */}
      <Card
        icon={<Shield size={14} className="text-ai" />}
        title={t('camp_map.card_evac', 'Evacuation readiness')}
        body={
          <ul className="text-xs space-y-1 text-slate-300">
            <li>
              {openAreaCount} {t('camp_map.open_areas', 'open area(s) — possible gathering point(s)')}
            </li>
            <li>
              {pathCount} {t('camp_map.paths_detected', 'path(s) — exit routes visible')}
            </li>
            <li>
              {buildingCount} {t('camp_map.buildings_detected', 'building(s) — possible shelter / command post')}
            </li>
            {pathCount <= 1 && (
              <li className="text-priority-medium flex items-center gap-1.5">
                <AlertTriangle size={12} />
                {t(
                  'camp_map.single_exit_warn',
                  'Only one or zero exit routes detected — single point of failure risk.'
                )}
              </li>
            )}
          </ul>
        }
      />

      {/* Task 9 — Flood / hazard impact */}
      <Card
        icon={<AlertTriangle size={14} className="text-ai" />}
        title={t('camp_map.card_hazard', 'Flood / hazard impact')}
        body={
          campMap.hazard_zones.length === 0 ? (
            <p className="text-xs text-slate-500 italic">
              {t(
                'camp_map.hazard_empty',
                'Use Paint mode (top of canvas) to draw a flood-risk polygon. The number of at-risk tents will appear here.'
              )}
            </p>
          ) : (
            <>
              <Big className="text-priority-critical">
                {atRiskTents.length}
              </Big>
              <p className="text-xs text-slate-300">
                {t(
                  'camp_map.hazard_at_risk',
                  'tent(s) inside the painted hazard zone(s). Plan pre-emptive relocation.'
                )}
              </p>
              <p className="text-[10px] text-slate-500 mt-1">
                {campMap.hazard_zones.length} {t('camp_map.hazard_zones', 'zone(s) painted')}
              </p>
            </>
          )
        }
      />

      {/* Notes from the model */}
      {campMap.notes && campMap.notes.length > 0 && (
        <Card
          icon={<Info size={14} className="text-slate-400" />}
          title={t('camp_map.card_notes', "Model's observations")}
          body={
            <ul className="text-xs text-slate-400 space-y-1 list-disc list-inside">
              {campMap.notes.map((n, i) => (
                <li key={i}>{n}</li>
              ))}
            </ul>
          }
        />
      )}
    </aside>
  );
}

// =========================================================================
// Card helper — tight visual container for each insights tile
// =========================================================================

function Card({
  icon,
  title,
  body,
}: {
  icon: React.ReactNode;
  title: string;
  body: React.ReactNode;
}) {
  return (
    <div className="bg-surface-light/40 border border-slate-700 rounded-lg p-3">
      <div className="flex items-center gap-1.5 text-xs font-semibold text-slate-200 mb-1.5">
        {icon}
        {title}
      </div>
      {body}
    </div>
  );
}

function Big({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={`text-2xl font-bold text-slate-100 leading-tight ${className ?? ''}`}>
      {children}
    </div>
  );
}
