// Reverse geocoding via OpenStreetMap's Nominatim service.
//
// Used to fill in missing address fields (street, city, country) on Starlink
// providers fetched from Overpass — many OSM contributors only tag the place
// with `name=Starlink` and `shop=telecommunication` without any addr:* tags,
// so we look them up by lat/lng instead.
//
// Nominatim usage policy (https://operations.osmfoundation.org/policies/nominatim/):
//   - Maximum 1 request per second
//   - Provide a meaningful User-Agent or Referer (browsers do this automatically)
//   - Cache results aggressively
//   - No bulk geocoding workloads
//
// We implement this politely: a global mutex + 1100 ms gap between requests,
// and we persist resolutions to IndexedDB so we never re-resolve the same point.

import { db } from '@/db/database';
import type { StarlinkProvider } from '@/types';

const NOMINATIM_URL = 'https://nominatim.openstreetmap.org/reverse';
const REQUEST_GAP_MS = 1100; // > 1s, conservative

interface NominatimResponse {
  display_name?: string;
  address?: {
    road?: string;
    house_number?: string;
    suburb?: string;
    neighbourhood?: string;
    village?: string;
    town?: string;
    city?: string;
    municipality?: string;
    state?: string;
    region?: string;
    postcode?: string;
    country?: string;
    country_code?: string;
  };
}

let lastRequestAt = 0;
let inFlight: Promise<unknown> | null = null;

/** Politeness gate — ensures REQUEST_GAP_MS between Nominatim hits. */
async function gate(): Promise<void> {
  if (inFlight) {
    try { await inFlight; } catch { /* ignore */ }
  }
  const now = Date.now();
  const wait = lastRequestAt + REQUEST_GAP_MS - now;
  if (wait > 0) {
    await new Promise((r) => setTimeout(r, wait));
  }
  lastRequestAt = Date.now();
}

export interface ResolvedAddress {
  street?: string;
  housenumber?: string;
  city?: string;
  state?: string;
  postcode?: string;
  suburb?: string;
  country?: string;
  country_code?: string;
  formatted_address?: string;
}

export async function reverseGeocode(lat: number, lng: number): Promise<ResolvedAddress | null> {
  await gate();
  const params = new URLSearchParams({
    format: 'jsonv2',
    lat: lat.toString(),
    lon: lng.toString(),
    zoom: '18', // building-level
    addressdetails: '1',
    'accept-language': navigator.language || 'en',
  });
  const promise = fetch(`${NOMINATIM_URL}?${params.toString()}`, {
    method: 'GET',
    headers: { Accept: 'application/json' },
  }).then(async (res) => {
    if (!res.ok) throw new Error(`Nominatim returned ${res.status}`);
    return res.json() as Promise<NominatimResponse>;
  });
  inFlight = promise;
  try {
    const data = await promise;
    const a = data.address ?? {};
    return {
      street: a.road,
      housenumber: a.house_number,
      city: a.city || a.town || a.village || a.municipality,
      suburb: a.suburb || a.neighbourhood,
      state: a.state || a.region,
      postcode: a.postcode,
      country: a.country,
      country_code: a.country_code?.toUpperCase(),
      formatted_address: data.display_name,
    };
  } catch (e) {
    console.warn('[nominatim] reverse failed', lat, lng, e);
    return null;
  } finally {
    inFlight = null;
  }
}

// ---- Batch resolver -----------------------------------------------------

export interface BatchProgress {
  total: number;
  resolved: number;
  failed: number;
  current?: string;
}

export type BatchObserver = (progress: BatchProgress) => void;

/**
 * Walks every provider that's still missing country/city, reverse-geocodes
 * it, and writes the resolved fields back to IndexedDB. Callers get a
 * progress callback so the UI can show "Resolving N of M…".
 *
 * Cancelable via an AbortSignal — when navigating away from the map page
 * we stop firing more requests.
 */
export async function resolveMissingAddresses(
  observe?: BatchObserver,
  signal?: AbortSignal
): Promise<BatchProgress> {
  const all = await db.providers
    .where('source')
    .equals('osm')
    .toArray();
  // Only resolve those we haven't successfully resolved yet
  const queue = all.filter(
    (p) => !p.address_resolved && (!p.country || !p.region)
  );
  const progress: BatchProgress = { total: queue.length, resolved: 0, failed: 0 };
  observe?.(progress);

  for (const p of queue) {
    if (signal?.aborted) break;
    progress.current = p.id;
    observe?.(progress);

    const r = await reverseGeocode(p.lat, p.lng);
    if (signal?.aborted) break;

    if (r) {
      // Region fallback chain: city → state → country. Many US / CA / IN /
      // BR markers reverse-geocode to (street + state + country) without
      // a city — e.g. an unincorporated rural address. Previously we
      // discarded the state entirely, leaving region blank and showing
      // only the country, which made "Texas, USA" indistinguishable
      // from "California, USA" in the UI. Falling through to state
      // recovers a useful regional label without adding a new field.
      const region =
        r.city ||
        (r as { state?: string }).state ||
        p.region ||
        r.country ||
        '';
      const updates: Partial<StarlinkProvider> = {
        country: r.country || p.country,
        country_code: r.country_code || p.country_code,
        region,
        street: r.street ?? p.street,
        housenumber: r.housenumber ?? p.housenumber,
        suburb: r.suburb ?? p.suburb,
        postcode: r.postcode ?? p.postcode,
        formatted_address: r.formatted_address || p.formatted_address,
        address_resolved: true,
      };
      try {
        await db.providers.update(p.id, updates);
        progress.resolved++;
      } catch {
        progress.failed++;
      }
    } else {
      progress.failed++;
    }
    observe?.({ ...progress });
  }
  progress.current = undefined;
  observe?.(progress);
  return progress;
}
