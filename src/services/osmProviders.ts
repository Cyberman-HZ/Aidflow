// Real Starlink provider/reseller data sourced from OpenStreetMap.
//
// Strategy:
//   1. Query OSM globally for any feature whose name / operator / brand
//      mentions "starlink" (case-insensitive). This catches official Starlink
//      stores, authorised resellers, and installer shops.
//   2. Persist the results in IndexedDB so the map works fully offline.
//   3. Refresh the cache when the device comes back online — at most once per
//      24h to be a good citizen on the public Overpass infrastructure.
//
// Privacy: only the query (no app data) is sent to overpass-api.de.
// API: https://wiki.openstreetmap.org/wiki/Overpass_API

import { db } from '@/db/database';
import type { StarlinkProvider } from '@/types';

// Public Overpass mirrors. We try them in order on each sync — if the first
// returns 429 (rate limited) or 504 (timeout), we fall through to the next.
// All mirrors expose the same Overpass QL API and CORS headers.
// List from https://wiki.openstreetmap.org/wiki/Overpass_API#Public_Overpass_API_instances
const OVERPASS_MIRRORS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.osm.ch/api/interpreter',
  'https://overpass.openstreetmap.fr/api/interpreter',
];
const SYNC_TIMESTAMP_KEY = 'aidflow:starlink-providers:last-sync';
const STALE_AFTER_MS = 24 * 60 * 60 * 1000; // 24 hours

interface OverpassElement {
  type: 'node' | 'way' | 'relation';
  id: number;
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  tags?: Record<string, string>;
}
interface OverpassResponse {
  elements: OverpassElement[];
}

// Global query: any OSM feature mentioning "starlink" in name/operator/brand.
// Worldwide footprint of Starlink-tagged places is small (~hundreds), so the
// response stays well under the Overpass timeout/size limits.
const GLOBAL_STARLINK_QUERY = `
[out:json][timeout:60];
(
  nwr["name"~"starlink",i];
  nwr["operator"~"starlink",i];
  nwr["brand"~"starlink",i];
);
out center tags 1500;
`.trim();

function classifyType(tags: Record<string, string>): StarlinkProvider['type'] {
  const search = `${tags.name ?? ''} ${tags.operator ?? ''} ${tags.brand ?? ''}`.toLowerCase();
  if (tags.shop === 'telecommunication' || tags.office === 'telecommunication') {
    return search.includes('starlink') ? 'official' : 'service_point';
  }
  if (tags.craft === 'electronics_repair' || tags.shop === 'electronics') return 'installer';
  if (search.includes('reseller') || search.includes('dealer')) return 'reseller';
  return 'reseller';
}

function nameOf(tags: Record<string, string>): string {
  return (
    tags.name ||
    tags['name:en'] ||
    tags.brand ||
    tags.operator ||
    'Starlink-tagged location'
  );
}

/** Build a one-line address from whatever pieces are available. */
function buildFormattedAddress(parts: {
  housenumber?: string;
  street?: string;
  suburb?: string;
  city?: string;
  postcode?: string;
  state?: string;
  country?: string;
}): string {
  const line1 = [parts.housenumber, parts.street].filter(Boolean).join(' ');
  const cityPart = [parts.postcode, parts.city || parts.suburb].filter(Boolean).join(' ');
  return [line1, cityPart, parts.state, parts.country].filter(Boolean).join(', ');
}

function toProvider(el: OverpassElement, syncTime: string): StarlinkProvider | null {
  const tags = el.tags ?? {};
  const lat = el.lat ?? el.center?.lat;
  const lng = el.lon ?? el.center?.lon;
  if (typeof lat !== 'number' || typeof lng !== 'number') return null;

  const search = `${tags.name ?? ''} ${tags.operator ?? ''} ${tags.brand ?? ''}`.toLowerCase();
  const isStarlink = search.includes('starlink');
  if (!isStarlink) return null;

  // Pull every addr:* tag OSM does provide. Reverse geocoding will fill in
  // the gaps for entries where these are missing.
  const street = tags['addr:street'] || undefined;
  const housenumber = tags['addr:housenumber'] || undefined;
  const postcode = tags['addr:postcode'] || undefined;
  const suburb = tags['addr:suburb'] || tags['addr:district'] || undefined;
  const city =
    tags['addr:city'] ||
    tags['addr:town'] ||
    tags['addr:village'] ||
    tags['addr:hamlet'] ||
    '';
  const state = tags['addr:state'] || tags['addr:province'] || undefined;
  const country = tags['addr:country'] || tags['is_in:country'] || '';
  const country_code = (
    tags['addr:country_code'] ||
    tags['ISO3166-1'] ||
    tags['ISO3166-1:alpha2'] ||
    ''
  ).toUpperCase() || undefined;

  const formatted_address = buildFormattedAddress({
    housenumber,
    street,
    suburb,
    city,
    postcode,
    state,
    country,
  });

  return {
    id: `osm-${el.type}-${el.id}`,
    name: nameOf(tags),
    country,
    region: city || state || suburb || '',
    type: classifyType(tags),
    lat,
    lng,
    phone: tags.phone || tags['contact:phone'] || undefined,
    hours: tags.opening_hours || undefined,
    notes: tags.website || tags['contact:website'] || undefined,
    signal: 'strong',
    custom: false,
    source: 'osm',
    osm_id: el.id,
    osm_type: el.type,
    source_url: `https://www.openstreetmap.org/${el.type}/${el.id}`,
    last_synced_at: syncTime,
    is_starlink_match: true,
    street,
    housenumber,
    postcode,
    suburb,
    country_code,
    formatted_address: formatted_address || undefined,
    address_resolved: false,
  };
}

// ---- Sync ----------------------------------------------------------------

export interface SyncResult {
  ok: boolean;
  cached: boolean;
  count: number;
  syncedAt: string | null;
  error?: string;
}

export function getLastSyncAt(): string | null {
  return localStorage.getItem(SYNC_TIMESTAMP_KEY);
}

export function isCacheStale(): boolean {
  const last = getLastSyncAt();
  if (!last) return true;
  return Date.now() - new Date(last).getTime() > STALE_AFTER_MS;
}

/**
 * Fetch the global "starlink"-tagged provider list from OSM and write the
 * result into IndexedDB, replacing any prior `source: 'osm'` rows.
 * User-added custom pins are NEVER touched.
 */
export async function syncStarlinkProviders(force = false): Promise<SyncResult> {
  const last = getLastSyncAt();
  if (typeof navigator !== 'undefined' && !navigator.onLine) {
    return { ok: false, cached: true, count: 0, syncedAt: last, error: 'offline' };
  }
  if (!force && !isCacheStale()) {
    return { ok: true, cached: true, count: await db.providers.where('source').equals('osm').count(), syncedAt: last };
  }

  try {
    const params = new URLSearchParams({ data: GLOBAL_STARLINK_QUERY });

    // Try each mirror in order. Retry the same mirror once after a short
    // backoff on 429 (rate limit) before falling through.
    let json: OverpassResponse | null = null;
    let lastErr: string | null = null;
    for (const url of OVERPASS_MIRRORS) {
      for (let attempt = 0; attempt < 2 && !json; attempt++) {
        try {
          const res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: params.toString(),
          });
          if (res.status === 429 || res.status === 504) {
            lastErr = `${new URL(url).hostname} returned ${res.status}`;
            // Wait 1.5s then retry the same mirror once before moving on
            if (attempt === 0) await new Promise((r) => setTimeout(r, 1500));
            continue;
          }
          if (!res.ok) {
            lastErr = `${new URL(url).hostname} returned ${res.status}`;
            break; // Non-retryable; try next mirror
          }
          json = (await res.json()) as OverpassResponse;
        } catch (e) {
          lastErr = `${new URL(url).hostname}: ${(e as Error).message}`;
          break; // Network error; try next mirror
        }
      }
      if (json) break;
    }
    if (!json) {
      throw new Error(
        `All Overpass mirrors are busy. Last error: ${lastErr ?? 'unknown'}. Try again in a minute.`
      );
    }
    const syncTime = new Date().toISOString();

    const providers: StarlinkProvider[] = [];
    const seen = new Set<string>();
    for (const el of json.elements ?? []) {
      const p = toProvider(el, syncTime);
      if (!p) continue;
      if (seen.has(p.id)) continue;
      seen.add(p.id);
      providers.push(p);
    }

    // Replace the OSM portion of the cache atomically; preserve custom pins.
    await db.transaction('rw', db.providers, async () => {
      const oldOsm = await db.providers
        .where('source')
        .equals('osm')
        .toArray();
      // Some pre-v2 entries have no `source` field but use the legacy "osm-..." id format
      const legacyOsmIds = (await db.providers.toArray())
        .filter((p) => !p.source && (p.id.startsWith('osm-') || p.id.startsWith('SL-')))
        .map((p) => p.id);
      await db.providers.bulkDelete([...oldOsm.map((p) => p.id), ...legacyOsmIds]);
      await db.providers.bulkAdd(providers);
    });

    localStorage.setItem(SYNC_TIMESTAMP_KEY, syncTime);
    return { ok: true, cached: false, count: providers.length, syncedAt: syncTime };
  } catch (e) {
    return {
      ok: false,
      cached: true,
      count: await db.providers.where('source').equals('osm').count().catch(() => 0),
      syncedAt: last,
      error: (e as Error).message,
    };
  }
}

/**
 * Read all Starlink-related providers from IndexedDB.
 * (Both OSM-cached entries and user custom pins.)
 */
export async function listProviders(): Promise<StarlinkProvider[]> {
  return db.providers.toArray();
}
