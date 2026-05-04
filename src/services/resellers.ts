// Starlink reseller dataset sync.
//
// Pulls from a curated JSON file in this very repo, hosted at
//   https://raw.githubusercontent.com/Cyberman-HZ/Aidflow/main/public/data/starlink-resellers.json
// so we can update the data by editing the file in the repo and pushing —
// the running app picks it up within an hour without a redeploy.
//
// Falls back to the bundled copy at /data/starlink-resellers.json if the
// remote fetch fails (offline, repo not yet pushed, GitHub rate limit, etc.).
//
// The 1-hour TTL matches the user spec: "sync every hour or when the user
// clicks refresh now".

import { db } from '@/db/database';
import type { ResellersDataset, StarlinkReseller } from '@/types';

const REMOTE_URL =
  'https://raw.githubusercontent.com/Cyberman-HZ/Aidflow/main/public/data/starlink-resellers.json';
const BUNDLED_URL = '/data/starlink-resellers.json';
const SYNC_TIMESTAMP_KEY = 'aidflow:resellers:last-sync';
const SYNC_DATASET_META_KEY = 'aidflow:resellers:dataset-meta';
const STALE_AFTER_MS = 60 * 60 * 1000; // 1 hour

export interface ResellerSyncResult {
  ok: boolean;
  cached: boolean;
  count: number;
  syncedAt: string | null;
  source: 'remote' | 'bundled' | 'cache';
  error?: string;
}

export interface ResellerDatasetMeta {
  version: number;
  updated_at: string;
  source_note?: string;
  official_directory_url?: string;
}

export function getLastSyncAt(): string | null {
  return localStorage.getItem(SYNC_TIMESTAMP_KEY);
}

export function getDatasetMeta(): ResellerDatasetMeta | null {
  const raw = localStorage.getItem(SYNC_DATASET_META_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as ResellerDatasetMeta;
  } catch {
    return null;
  }
}

export function isCacheStale(): boolean {
  const last = getLastSyncAt();
  if (!last) return true;
  return Date.now() - new Date(last).getTime() > STALE_AFTER_MS;
}

async function fetchJson(url: string): Promise<ResellersDataset> {
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(`${url} → ${res.status}`);
  const data = (await res.json()) as ResellersDataset;
  if (!Array.isArray(data?.resellers)) throw new Error(`${url}: malformed dataset`);
  return data;
}

/**
 * Pull the reseller dataset (remote first, then bundled fallback) and replace
 * the IndexedDB rows in one transaction. Returns metadata so the UI can show
 * "X resellers · last sync 5 min ago · from GitHub".
 */
export async function syncResellers(force = false): Promise<ResellerSyncResult> {
  const last = getLastSyncAt();
  const online = typeof navigator !== 'undefined' ? navigator.onLine : true;

  // If cache is fresh and not forced, just return what's stored.
  if (!force && !isCacheStale()) {
    return {
      ok: true,
      cached: true,
      count: await db.resellers.count(),
      syncedAt: last,
      source: 'cache',
    };
  }

  let dataset: ResellersDataset | null = null;
  let source: ResellerSyncResult['source'] = 'cache';
  let error: string | undefined;

  if (online) {
    try {
      dataset = await fetchJson(REMOTE_URL);
      source = 'remote';
    } catch (e) {
      error = (e as Error).message;
      // fall through to bundled
    }
  }

  if (!dataset) {
    try {
      dataset = await fetchJson(BUNDLED_URL);
      source = 'bundled';
    } catch (e) {
      // Both remote and bundled failed — return whatever's already in the DB.
      return {
        ok: false,
        cached: true,
        count: await db.resellers.count(),
        syncedAt: last,
        source: 'cache',
        error: error ?? (e as Error).message,
      };
    }
  }

  // Replace the table contents atomically
  const fresh: StarlinkReseller[] = dataset.resellers.map((r) => ({
    ...r,
    id: r.id || `${r.continent}-${r.country}-${r.name}`.toLowerCase().replace(/\s+/g, '-'),
  }));

  await db.transaction('rw', db.resellers, async () => {
    await db.resellers.clear();
    await db.resellers.bulkAdd(fresh);
  });

  const syncTime = new Date().toISOString();
  localStorage.setItem(SYNC_TIMESTAMP_KEY, syncTime);
  localStorage.setItem(
    SYNC_DATASET_META_KEY,
    JSON.stringify({
      version: dataset.version,
      updated_at: dataset.updated_at,
      source_note: dataset.source_note,
      official_directory_url: dataset.official_directory_url,
    } satisfies ResellerDatasetMeta)
  );

  return {
    ok: true,
    cached: false,
    count: fresh.length,
    syncedAt: syncTime,
    source,
  };
}
