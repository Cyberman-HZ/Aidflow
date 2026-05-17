// AidFlow Pro — Drone Camp Planner service.
//
// Pipeline:
//   1. User uploads an aerial image (drone, phone-from-roof, satellite
//      screenshot — anything top-down).
//   2. We resize it via imageUtils.fileToResizedJpegBase64 so Gemma 4 can
//      process it on CPU in a sensible time.
//   3. Send to Ollama's chatWithImage with format=json and a strict
//      schema prompt asking the model to return features in normalized
//      coordinates (0..1) so they survive any later resize.
//   4. Validate + sanitize the response. Drop malformed entries instead
//      of failing the whole extraction.
//   5. Persist to the campMaps table (singleton 'current' row for MVP)
//      and record an aiTrace audit row.
//
// Everything offline-local. No tile services, no cloud, no third-party
// APIs. The image bytes live in IndexedDB so the page survives reload
// even with no network.

import { db } from '@/db/database';
import type {
  AidDistribution,
  CampFamilyPin,
  CampFeature,
  CampFeatureConfidence,
  CampFeatureType,
  CampHazardZone,
  CampMap,
  Family,
} from '@/types';
import { chatWithImage, pingOllama } from '@/services/ollama';
import { fileToResizedJpegBase64 } from '@/services/imageUtils';
import { recordTrace } from '@/services/aiTrace';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SINGLETON_ID = 'current';

/** Default assumption when computing population from tent count. */
export const DEFAULT_AVG_HOUSEHOLD_SIZE = 5;

/**
 * Sphere humanitarian standards — minimum acceptable ratios. Used by the
 * insights panel to flag gaps. Embedded here as constants; future versions
 * may move these to Settings.
 *
 * Source: Sphere Handbook 2018, WASH chapter.
 */
export const SPHERE = {
  /** Minimum: 1 latrine per 20 people. */
  PEOPLE_PER_LATRINE: 20,
  /** Minimum: 1 water point per 250 people (taps + hand-dug wells). */
  PEOPLE_PER_WATER_POINT: 250,
  /** Litres per person per day. */
  WATER_LITRES_PER_PERSON_DAY: 15,
} as const;

const ALLOWED_FEATURE_TYPES: ReadonlySet<CampFeatureType> = new Set([
  'tent',
  'water_point',
  'latrine',
  'building',
  'vehicle',
  'open_area',
  'path',
]);

const CONFIDENCE_VALUES: readonly CampFeatureConfidence[] = ['high', 'medium', 'low'];

// ---------------------------------------------------------------------------
// Vision pipeline
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `You are a humanitarian field analyst reviewing a top-down aerial image of a displaced-persons settlement, refugee camp, or temporary shelter site.

Identify visible features. Return STRICT JSON matching the schema below. Use NORMALIZED coordinates in [0, 1]: x is the fraction from the left edge, y is the fraction from the top edge. (0.5, 0.5) is the centre of the image.

SCHEMA:
{
  "features": [
    {"type": "tent",         "x": 0..1, "y": 0..1, "confidence": "high"|"medium"|"low"},
    {"type": "water_point",  "x": 0..1, "y": 0..1, "confidence": "..."},
    {"type": "latrine",      "x": 0..1, "y": 0..1, "confidence": "..."},
    {"type": "building",     "x": 0..1, "y": 0..1, "label": "medical"|"warehouse"|"community"|"unknown", "confidence": "..."},
    {"type": "vehicle",      "x": 0..1, "y": 0..1, "confidence": "..."},
    {"type": "open_area",    "polygon": [[x,y], [x,y], ...], "confidence": "..."},
    {"type": "path",         "polyline": [[x,y], [x,y], ...], "confidence": "..."}
  ],
  "notes": ["short observation 1", "short observation 2"]
}

RULES:
1. Tents include any small temporary shelter (tent, tarp, prefab cabin, makeshift dwelling).
2. Water points include taps, water tanks, wells, distribution stations, water tankers.
3. Latrines include any structure that looks like a sanitation unit; if unsure mark confidence=low.
4. Buildings are larger / permanent-looking structures. Use the label to guess function from visual cues (cross/red-crescent → medical, large rectangular → warehouse, central pavilion → community).
5. Open areas are unoccupied spaces large enough for distributions, evacuations, or future shelter — represent them as a closed polygon of 3-8 points.
6. Paths are visible roads, tracks, or footpaths between clusters — represent as a polyline of 2-10 points.
7. Vehicles are cars, trucks, or buses visible in the image.
8. NEVER invent features you can't see. NEVER guess a tent that's not visually present. Quality > quantity.
9. Cap tents at 200, other types at 50 each.
10. Output ONLY the JSON. No markdown fences, no prose, no preamble.`;

interface ExtractionResult {
  features: CampFeature[];
  notes: string[];
}

/**
 * Send an aerial image to Gemma 4 vision and parse the structured output.
 * Returns sanitized features ready to render. Throws on network / model
 * failure so the caller can present a useful error message.
 */
export async function extractCampFeaturesFromImage(
  imageBase64: string,
  opts: { language?: 'en' | 'ar' | 'fr' | 'es' } = {}
): Promise<ExtractionResult> {
  const ok = await pingOllama();
  if (!ok) {
    throw new Error(
      'Ollama is not reachable. Start it with `OLLAMA_ORIGINS=* ollama serve` and pull a vision-capable Gemma 4 model.'
    );
  }
  const langName =
    opts.language === 'ar'
      ? 'Arabic'
      : opts.language === 'fr'
      ? 'French'
      : opts.language === 'es'
      ? 'Spanish'
      : 'English';
  const userPrompt = `Analyze this aerial image of a settlement and return the JSON described in the system message. Respond in ${langName} for the "notes" array.`;
  const raw = await chatWithImage(
    [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: userPrompt },
    ],
    [imageBase64],
    { temperature: 0.2, maxTokens: 4096, jsonMode: true }
  );
  return parseAndSanitize(raw);
}

/**
 * Defensive parser. Strips fences, slices to the outermost {...}, drops
 * malformed entries, clamps coordinates into [0,1]. The whole point is to
 * NEVER throw on an imperfect model response — return whatever's valid.
 */
export function parseAndSanitize(raw: string): ExtractionResult {
  const cleaned = raw
    .replace(/^```(?:json)?/i, '')
    .replace(/```$/i, '')
    .trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  const sliced = start >= 0 && end > start ? cleaned.slice(start, end + 1) : cleaned;
  let parsed: unknown;
  try {
    parsed = JSON.parse(sliced);
  } catch {
    return { features: [], notes: ['The model did not return valid JSON; nothing extracted.'] };
  }
  if (!parsed || typeof parsed !== 'object') {
    return { features: [], notes: [] };
  }
  const obj = parsed as Record<string, unknown>;
  const rawFeatures = Array.isArray(obj.features) ? obj.features : [];
  const features: CampFeature[] = [];
  const counters: Record<string, number> = {};
  for (const f of rawFeatures) {
    const sf = sanitizeFeature(f, counters);
    if (sf) features.push(sf);
  }
  const notes = Array.isArray(obj.notes)
    ? obj.notes
        .map((n) => (typeof n === 'string' ? n.slice(0, 300) : ''))
        .filter((n) => !!n)
        .slice(0, 8)
    : [];
  return { features, notes };
}

function sanitizeFeature(raw: unknown, counters: Record<string, number>): CampFeature | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const type = typeof r.type === 'string' ? (r.type as CampFeatureType) : null;
  if (!type || !ALLOWED_FEATURE_TYPES.has(type)) return null;
  counters[type] = (counters[type] ?? 0) + 1;
  const id = `${type}-${counters[type]}`;
  const confidence = CONFIDENCE_VALUES.includes(r.confidence as CampFeatureConfidence)
    ? (r.confidence as CampFeatureConfidence)
    : 'medium';
  // open_area expects a polygon; path expects a polyline; everything else uses x/y.
  if (type === 'open_area') {
    const polygon = sanitizePointList(r.polygon, 3, 16);
    if (!polygon) return null;
    return { id, type, polygon, confidence };
  }
  if (type === 'path') {
    const polyline = sanitizePointList(r.polyline, 2, 16);
    if (!polyline) return null;
    return { id, type, polyline, confidence };
  }
  const x = clamp01(asNumber(r.x));
  const y = clamp01(asNumber(r.y));
  if (x == null || y == null) return null;
  const label = type === 'building' && typeof r.label === 'string' ? r.label.slice(0, 32) : undefined;
  return { id, type, x, y, label, confidence };
}

function sanitizePointList(
  raw: unknown,
  min: number,
  max: number
): Array<[number, number]> | null {
  if (!Array.isArray(raw)) return null;
  const out: Array<[number, number]> = [];
  for (const p of raw) {
    if (!Array.isArray(p) || p.length < 2) continue;
    const x = clamp01(asNumber(p[0]));
    const y = clamp01(asNumber(p[1]));
    if (x == null || y == null) continue;
    out.push([x, y]);
    if (out.length >= max) break;
  }
  return out.length >= min ? out : null;
}

function asNumber(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function clamp01(v: number | null): number | null {
  if (v == null) return null;
  if (v < 0) return 0;
  if (v > 1) return 1;
  return v;
}

// ---------------------------------------------------------------------------
// Image upload + analyze + persist (the orchestration entry point)
// ---------------------------------------------------------------------------

export interface AnalyzeAndStoreOpts {
  uploaded_by: string;
  source_kind?: string;
  language?: 'en' | 'ar' | 'fr' | 'es';
}

export interface AnalyzeAndStoreResult {
  campMap: CampMap;
  trace_id: string;
  duration_ms: number;
}

/**
 * One-shot: take a File, resize, run vision, store, audit. Used by the
 * upload button on the /camp-map page.
 */
export async function analyzeAndStoreImage(
  file: File,
  opts: AnalyzeAndStoreOpts
): Promise<AnalyzeAndStoreResult> {
  const startedAt = Date.now();
  const resized = await fileToResizedJpegBase64(file, { maxDim: 1280, quality: 0.82 });
  // The Blob we store is reconstructed from the resized base64 so we don't
  // keep a 30 MB original around. ~500 KB is plenty for the canvas.
  const imageBlob = base64ToBlob(resized.base64, 'image/jpeg');

  let features: CampFeature[] = [];
  let notes: string[] = [];
  let error: string | undefined;
  try {
    const ex = await extractCampFeaturesFromImage(resized.base64, { language: opts.language });
    features = ex.features;
    notes = ex.notes;
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }

  const row: CampMap = {
    id: SINGLETON_ID,
    image: imageBlob,
    image_mime: 'image/jpeg',
    image_width: resized.width,
    image_height: resized.height,
    uploaded_at: new Date().toISOString(),
    uploaded_by: opts.uploaded_by,
    source_kind: opts.source_kind,
    features,
    notes,
    hazard_zones: [],
    family_pins: [],
    avg_household_size: DEFAULT_AVG_HOUSEHOLD_SIZE,
  };

  // Audit trace first so it exists even if the DB put fails mid-way.
  const tallies = features.reduce<Record<string, number>>((acc, f) => {
    acc[f.type] = (acc[f.type] ?? 0) + 1;
    return acc;
  }, {});
  const trace_id = await recordTrace({
    source: 'camp_map',
    language: opts.language,
    inputs_summary: `Aerial image ${resized.width}×${resized.height}, ${approxKb(resized.base64)} KB`,
    response_text: JSON.stringify({ tallies, notes }, null, 2),
    duration_ms: Date.now() - startedAt,
    error,
    metadata: {
      image_width: resized.width,
      image_height: resized.height,
      feature_count: features.length,
      tallies,
      source_kind: opts.source_kind,
    },
  });
  row.last_trace_id = trace_id;
  await db.campMaps.put(row);
  return { campMap: row, trace_id, duration_ms: Date.now() - startedAt };
}

function base64ToBlob(b64: string, mime: string): Blob {
  const bin = atob(b64);
  const len = bin.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

function approxKb(b64: string): number {
  return Math.round((b64.length * 0.75) / 1024);
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export async function getCurrentCampMap(): Promise<CampMap | undefined> {
  return await db.campMaps.get(SINGLETON_ID);
}

export async function clearCurrentCampMap(): Promise<void> {
  await db.campMaps.delete(SINGLETON_ID);
}

// ---------------------------------------------------------------------------
// Mutations — patching pins and hazard zones on the current CampMap
// ---------------------------------------------------------------------------

export async function setHazardZones(zones: CampHazardZone[]): Promise<void> {
  const row = await getCurrentCampMap();
  if (!row) return;
  await db.campMaps.update(SINGLETON_ID, { hazard_zones: zones });
}

export async function setFamilyPins(pins: CampFamilyPin[]): Promise<void> {
  const row = await getCurrentCampMap();
  if (!row) return;
  await db.campMaps.update(SINGLETON_ID, { family_pins: pins });
}

export async function setAvgHouseholdSize(n: number): Promise<void> {
  const row = await getCurrentCampMap();
  if (!row) return;
  await db.campMaps.update(SINGLETON_ID, { avg_household_size: Math.max(1, Math.floor(n)) });
}

// ---------------------------------------------------------------------------
// Geometry / math helpers used by the insights panel
// ---------------------------------------------------------------------------

export function tentsOf(features: CampFeature[]): CampFeature[] {
  return features.filter((f) => f.type === 'tent');
}

export function waterPointsOf(features: CampFeature[]): CampFeature[] {
  return features.filter((f) => f.type === 'water_point');
}

export function latrinesOf(features: CampFeature[]): CampFeature[] {
  return features.filter((f) => f.type === 'latrine');
}

export function openAreasOf(features: CampFeature[]): CampFeature[] {
  return features.filter((f) => f.type === 'open_area');
}

export function pathsOf(features: CampFeature[]): CampFeature[] {
  return features.filter((f) => f.type === 'path');
}

export function buildingsOf(features: CampFeature[]): CampFeature[] {
  return features.filter((f) => f.type === 'building');
}

/** Population estimate from tent count × avg household size. */
export function estimatePopulation(
  features: CampFeature[],
  avgHouseholdSize = DEFAULT_AVG_HOUSEHOLD_SIZE
): { tents: number; population: number } {
  const tents = tentsOf(features).length;
  return { tents, population: tents * avgHouseholdSize };
}

/**
 * Geometric centroid of tent positions — the obvious starting point for
 * a new distribution / medical / nutrition tent. Returns null when no
 * tents exist.
 */
export function tentCentroid(features: CampFeature[]): { x: number; y: number } | null {
  const tents = tentsOf(features);
  if (tents.length === 0) return null;
  let sx = 0;
  let sy = 0;
  let n = 0;
  for (const t of tents) {
    if (typeof t.x === 'number' && typeof t.y === 'number') {
      sx += t.x;
      sy += t.y;
      n++;
    }
  }
  if (n === 0) return null;
  return { x: sx / n, y: sy / n };
}

/**
 * Weighted centroid using a per-family weight. Used for the
 * medical-tent suggestion (weight = vulnerability score).
 */
export function weightedFamilyCentroid(
  pins: ReadonlyArray<{ feature_id: string; weight: number }>,
  features: CampFeature[]
): { x: number; y: number } | null {
  const byId = new Map(features.map((f) => [f.id, f] as const));
  let sx = 0;
  let sy = 0;
  let sw = 0;
  for (const p of pins) {
    const f = byId.get(p.feature_id);
    if (!f || typeof f.x !== 'number' || typeof f.y !== 'number') continue;
    const w = Math.max(0, p.weight);
    if (w === 0) continue;
    sx += f.x * w;
    sy += f.y * w;
    sw += w;
  }
  if (sw === 0) return null;
  return { x: sx / sw, y: sy / sw };
}

/**
 * Sphere compliance against current tent / latrine / water counts.
 * The "gap" is how many of each we'd need to be in compliance — useful
 * for procurement planning.
 */
export interface SphereReport {
  population: number;
  latrines: number;
  water_points: number;
  latrine_ratio: number | null;
  water_ratio: number | null;
  latrine_gap: number;
  water_gap: number;
  latrine_ok: boolean;
  water_ok: boolean;
}

export function sphereReport(
  features: CampFeature[],
  avgHouseholdSize = DEFAULT_AVG_HOUSEHOLD_SIZE
): SphereReport {
  const { population } = estimatePopulation(features, avgHouseholdSize);
  const latrines = latrinesOf(features).length;
  const waters = waterPointsOf(features).length;
  const latrine_ratio = latrines === 0 ? null : population / latrines;
  const water_ratio = waters === 0 ? null : population / waters;
  const required_latrines = Math.ceil(population / SPHERE.PEOPLE_PER_LATRINE);
  const required_waters = Math.ceil(population / SPHERE.PEOPLE_PER_WATER_POINT);
  return {
    population,
    latrines,
    water_points: waters,
    latrine_ratio,
    water_ratio,
    latrine_gap: Math.max(0, required_latrines - latrines),
    water_gap: Math.max(0, required_waters - waters),
    latrine_ok: latrines >= required_latrines,
    water_ok: waters >= required_waters,
  };
}

/**
 * Unregistered-arrivals estimate. Compare the AI's tent count against
 * the number of non-deleted family registrations. The difference is the
 * "register these" backlog. Negative means more registered than tents —
 * could indicate over-registration or unseen tents.
 */
export function unregisteredEstimate(
  features: CampFeature[],
  families: ReadonlyArray<Family>
): { tent_count: number; registered: number; delta: number; direction: 'unregistered' | 'over' | 'matched' } {
  const tent_count = tentsOf(features).length;
  const registered = families.filter((f) => !f.deleted_at).length;
  const delta = tent_count - registered;
  return {
    tent_count,
    registered,
    delta: Math.abs(delta),
    direction: delta > 0 ? 'unregistered' : delta < 0 ? 'over' : 'matched',
  };
}

/**
 * Underserved-zones analysis. Pin each family to its tent, look up its
 * last-aid date, and tally per-region recency.
 *
 * The "region" is computed as a coarse 3×3 grid over the image so the
 * UI can colour-code quadrants without a full clustering algorithm.
 */
export interface UnderservedZone {
  cell_x: 0 | 1 | 2;
  cell_y: 0 | 1 | 2;
  family_count: number;
  oldest_days: number; // max days since last aid in this cell
  median_days: number;
  served_recent: number; // families served in last 7 days
}

export function underservedZones(
  features: CampFeature[],
  pins: ReadonlyArray<CampFamilyPin>,
  families: ReadonlyArray<Family>
): UnderservedZone[] {
  const byId = new Map(features.map((f) => [f.id, f] as const));
  const famById = new Map(families.map((f) => [f.family_id, f] as const));
  type Cell = { x: 0 | 1 | 2; y: 0 | 1 | 2; days: number[]; recent: number };
  const grid: Cell[][] = [];
  for (let y = 0; y < 3; y++) {
    const row: Cell[] = [];
    for (let x = 0; x < 3; x++) row.push({ x: x as 0 | 1 | 2, y: y as 0 | 1 | 2, days: [], recent: 0 });
    grid.push(row);
  }
  for (const pin of pins) {
    const feature = byId.get(pin.feature_id);
    const fam = famById.get(pin.family_id);
    if (!feature || !fam) continue;
    if (typeof feature.x !== 'number' || typeof feature.y !== 'number') continue;
    const cx = Math.min(2, Math.floor(feature.x * 3)) as 0 | 1 | 2;
    const cy = Math.min(2, Math.floor(feature.y * 3)) as 0 | 1 | 2;
    const cell = grid[cy][cx];
    const days = fam.last_aid_at
      ? Math.floor((Date.now() - new Date(fam.last_aid_at).getTime()) / 86_400_000)
      : 999;
    cell.days.push(days);
    if (days <= 7) cell.recent++;
  }
  const out: UnderservedZone[] = [];
  for (const row of grid) {
    for (const c of row) {
      if (c.days.length === 0) continue;
      const sorted = [...c.days].sort((a, b) => a - b);
      out.push({
        cell_x: c.x,
        cell_y: c.y,
        family_count: c.days.length,
        oldest_days: sorted[sorted.length - 1],
        median_days: sorted[Math.floor(sorted.length / 2)],
        served_recent: c.recent,
      });
    }
  }
  return out;
}

/**
 * Point-in-polygon test (ray casting). Used to determine which tents
 * fall inside an admin-painted flood / hazard zone polygon. Polygon
 * coordinates are normalized (0..1), as are the tent coordinates.
 */
export function pointInPolygon(
  px: number,
  py: number,
  polygon: ReadonlyArray<readonly [number, number]>
): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, yi] = polygon[i];
    const [xj, yj] = polygon[j];
    const intersect =
      yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi + 1e-12) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

/** Tents that fall inside ANY of the given hazard zone polygons. */
export function tentsInHazardZones(
  features: CampFeature[],
  zones: ReadonlyArray<CampHazardZone>
): CampFeature[] {
  if (zones.length === 0) return [];
  const tents = tentsOf(features);
  return tents.filter((t) => {
    if (typeof t.x !== 'number' || typeof t.y !== 'number') return false;
    for (const z of zones) {
      if (pointInPolygon(t.x, t.y, z.polygon)) return true;
    }
    return false;
  });
}

/**
 * Suggest a route from the distribution-point centroid to each tent
 * cluster — for MVP we just return straight lines from the centroid to
 * every tent. A future version could use the detected paths to plan an
 * actual route along visible footways.
 */
export function suggestedDeliveryRoutes(features: CampFeature[]): Array<{
  from: { x: number; y: number };
  to: { x: number; y: number };
}> {
  const c = tentCentroid(features);
  if (!c) return [];
  return tentsOf(features)
    .filter((t) => typeof t.x === 'number' && typeof t.y === 'number')
    .slice(0, 50) // cap so the SVG doesn't drown
    .map((t) => ({ from: c, to: { x: t.x as number, y: t.y as number } }));
}

/**
 * Compute the per-family vulnerability score used to weight the
 * medical-tent centroid. Higher = more vulnerable. Pure heuristic.
 */
export function vulnerabilityScore(f: Family, history: ReadonlyArray<AidDistribution>): number {
  let score = 0;
  score += (f.children_under_5 ?? 0) * 4;
  score += (f.elderly_count ?? 0) * 3;
  if (f.has_pregnant_member) score += 5;
  if (f.medical_conditions?.length) score += 4 + f.medical_conditions.length;
  if (f.income_level === 'none') score += 3;
  if (f.displacement_status === 'recently_displaced') score += 2;
  if (f.displacement_status === 'refugee') score += 3;
  // Recency: families unseen for 14+ days get a boost so they pull the
  // suggested centroid back toward them.
  const lastAt = f.last_aid_at ? new Date(f.last_aid_at).getTime() : 0;
  const days = lastAt > 0 ? Math.floor((Date.now() - lastAt) / 86_400_000) : 999;
  if (days >= 14) score += Math.min(8, Math.floor(days / 7));
  // Use history if available to lightly nudge for unmet historical needs;
  // not strictly necessary but keeps the signal more stable.
  if (history.length === 0) score += 1;
  return score;
}
