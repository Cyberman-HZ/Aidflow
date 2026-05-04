// Starlink page (no map). Two sections:
//   1. Country availability — which countries have Starlink residential service.
//   2. Authorized retailers — extracted from the official Starlink article,
//      grouped by continent, refreshed hourly from a JSON file in this repo.

import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Sparkles,
  ExternalLink,
  Globe,
  CheckCircle2,
  RefreshCw,
  WifiOff,
  Search,
  Store,
  AlertCircle,
} from 'lucide-react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '@/db/database';
import { Card } from '@/components/Card';
import EmptyState from '@/components/EmptyState';
import {
  syncResellers,
  isCacheStale,
  getLastSyncAt,
  getDatasetMeta,
  type ResellerSyncResult,
} from '@/services/resellers';
import {
  COUNTRIES,
  STATUS_COLOR,
  STATUS_LABEL,
  LAST_UPDATED,
  OFFICIAL_MAP_URL,
  type CountryEntry,
  type CoverageStatus,
} from '@/services/starlinkCountries';
import { useConnectivityStore } from '@/stores/connectivityStore';
import type { Continent, StarlinkReseller } from '@/types';

const OFFICIAL_RESELLERS_URL =
  'https://starlink.com/support/article/8a90222d-7c32-edd7-51f6-f696ece07105';

const CONTINENT_ORDER: Continent[] = [
  'Africa',
  'Asia-Pacific',
  'Europe',
  'Latin America',
  'Middle East',
  'North America',
  'Oceania',
];

export default function StarlinkPage() {
  const { t } = useTranslation();
  const internetUp = useConnectivityStore((s) => s.internetUp);

  const resellers = useLiveQuery(() => db.resellers.toArray()) ?? [];
  const [syncing, setSyncing] = useState(false);
  const [lastResult, setLastResult] = useState<ResellerSyncResult | null>(null);

  // Auto-sync every hour. Initial: if cache empty or stale, fire now.
  // Then a setInterval re-checks every 5 minutes; if stale + online, sync.
  useEffect(() => {
    if (internetUp && (isCacheStale() || resellers.length === 0)) {
      void runSync(false);
    }
    const id = setInterval(() => {
      if (navigator.onLine && isCacheStale()) {
        void runSync(false);
      }
    }, 5 * 60 * 1000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [internetUp]);

  const runSync = async (force: boolean) => {
    setSyncing(true);
    try {
      const res = await syncResellers(force);
      setLastResult(res);
    } finally {
      setSyncing(false);
    }
  };

  const lastSyncAt = getLastSyncAt();
  const meta = getDatasetMeta();
  const lastSyncLabel = lastSyncAt ? formatRelative(new Date(lastSyncAt)) : 'never';

  return (
    <div className="space-y-5">
      <header>
        <h1 className="text-2xl font-bold flex items-center gap-2">
          <Sparkles size={22} className="text-brand" />
          {t('map.title')}
        </h1>
        <p className="text-sm text-slate-400 mt-1">
          Country coverage and the official list of Starlink authorized retailers,
          synced from{' '}
          <a
            href={OFFICIAL_RESELLERS_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="text-brand underline"
          >
            starlink.com
          </a>
          . Auto-updates once an hour while online.
        </p>
      </header>

      {/* Sync status bar */}
      <Card>
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-2 text-sm flex-1 min-w-0">
            {syncing ? (
              <>
                <RefreshCw size={16} className="animate-spin text-ai" />
                <span className="text-ai">Syncing reseller list…</span>
              </>
            ) : !internetUp ? (
              <>
                <WifiOff size={16} className="text-priority-medium" />
                <span className="text-slate-300 truncate">
                  Offline — using cached data ({resellers.length} resellers)
                </span>
              </>
            ) : (
              <>
                <CheckCircle2 size={16} className="text-priority-normal" />
                <span className="text-slate-300 truncate">
                  {resellers.length} authorized resellers · last sync {lastSyncLabel}
                  {lastResult?.source === 'remote' && ' (from GitHub)'}
                  {lastResult?.source === 'bundled' && ' (bundled fallback)'}
                </span>
              </>
            )}
            {lastResult?.error && (
              <span className="text-xs text-priority-critical ms-2 truncate">
                ({lastResult.error})
              </span>
            )}
          </div>
          <button
            onClick={() => void runSync(true)}
            disabled={syncing}
            className="touch-target px-3 py-2 bg-ai hover:bg-violet-600 disabled:opacity-50 rounded-lg text-sm flex items-center gap-2 font-semibold"
          >
            <RefreshCw size={14} className={syncing ? 'animate-spin' : ''} />
            Refresh now
          </button>
          <a
            href={OFFICIAL_RESELLERS_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="touch-target px-3 py-2 bg-surface-light hover:bg-slate-600 rounded-lg text-sm flex items-center gap-2"
          >
            <ExternalLink size={14} /> Official directory
          </a>
        </div>
        {meta && (
          <p className="text-xs text-slate-500 mt-2">
            Dataset version {meta.version} · last edited {meta.updated_at}
          </p>
        )}
      </Card>

      {/* Country availability */}
      <CountryAvailabilityPanel />

      {/* Resellers grouped by continent */}
      <ResellersPanel resellers={resellers} />
    </div>
  );
}

// =========================================================================
// Country availability
// =========================================================================

function CountryAvailabilityPanel() {
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<CoverageStatus | ''>('');

  const filtered = useMemo<CountryEntry[]>(() => {
    return COUNTRIES.filter(
      (c) =>
        (!statusFilter || c.status === statusFilter) &&
        (!search ||
          c.name.toLowerCase().includes(search.toLowerCase()) ||
          c.code.toLowerCase().includes(search.toLowerCase()))
    );
  }, [search, statusFilter]);

  const counts = COUNTRIES.reduce<Record<CoverageStatus, number>>(
    (acc, c) => {
      acc[c.status]++;
      return acc;
    },
    { available: 0, soon: 0, waitlist: 0, unavailable: 0 }
  );

  return (
    <Card
      title={
        <div className="flex items-center gap-2">
          <Globe size={14} /> Starlink country availability
        </div>
      }
    >
      <div className="flex flex-wrap gap-2 items-center mb-3">
        <div className="relative flex-1 min-w-[180px]">
          <Search
            size={14}
            className="absolute top-1/2 -translate-y-1/2 start-2.5 text-slate-500"
          />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search country…"
            className="w-full bg-surface-deep border border-slate-700 rounded-lg ps-8 pe-2 py-1.5 text-sm focus:border-brand outline-none"
          />
        </div>
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value as CoverageStatus | '')}
          className="bg-surface-deep border border-slate-700 rounded-lg px-2 py-1.5 text-sm focus:border-brand"
        >
          <option value="">All statuses</option>
          {(Object.keys(STATUS_LABEL) as CoverageStatus[]).map((s) => (
            <option key={s} value={s}>
              {STATUS_LABEL[s]}
            </option>
          ))}
        </select>
      </div>

      <div className="flex flex-wrap gap-2 mb-3 text-[11px]">
        {(Object.keys(STATUS_LABEL) as CoverageStatus[]).map((s) => (
          <span
            key={s}
            className="inline-flex items-center gap-1 bg-surface-light px-2 py-0.5 rounded-full"
            style={{ color: STATUS_COLOR[s] }}
          >
            <span className="w-2 h-2 rounded-full" style={{ backgroundColor: STATUS_COLOR[s] }} />
            {STATUS_LABEL[s]} · {counts[s]}
          </span>
        ))}
      </div>

      <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-x-3 gap-y-1 max-h-72 overflow-y-auto">
        {filtered.length === 0 ? (
          <p className="text-sm text-slate-500 text-center py-4 col-span-full">
            No countries match.
          </p>
        ) : (
          filtered.map((c) => (
            <a
              key={c.code}
              href={OFFICIAL_MAP_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-2 px-2 py-1.5 rounded hover:bg-surface-light text-sm transition-colors"
              title="Open Starlink official map"
            >
              <span
                className="w-2.5 h-2.5 rounded-full flex-shrink-0"
                style={{ backgroundColor: STATUS_COLOR[c.status] }}
              />
              <span className="text-xs text-slate-500 font-mono w-7">{c.code}</span>
              <span className="flex-1 truncate">{c.name}</span>
              {c.notes && (
                <span className="text-[10px] text-priority-medium italic truncate max-w-[100px]">
                  {c.notes}
                </span>
              )}
              <ExternalLink size={11} className="text-slate-500 flex-shrink-0" />
            </a>
          ))
        )}
      </div>

      <p className="text-[11px] text-slate-500 mt-3 pt-2 border-t border-slate-700">
        Snapshot from {LAST_UPDATED}. Click any country to verify on the live{' '}
        <a
          href={OFFICIAL_MAP_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="text-brand underline"
        >
          Starlink Availability Map
        </a>
        .
      </p>
    </Card>
  );
}

// =========================================================================
// Authorized resellers
// =========================================================================

function ResellersPanel({ resellers }: { resellers: StarlinkReseller[] }) {
  const [search, setSearch] = useState('');
  const [continentFilter, setContinentFilter] = useState<Continent | ''>('');

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return resellers.filter(
      (r) =>
        (!continentFilter || r.continent === continentFilter) &&
        (!q ||
          r.name.toLowerCase().includes(q) ||
          r.country.toLowerCase().includes(q) ||
          r.continent.toLowerCase().includes(q))
    );
  }, [resellers, search, continentFilter]);

  const grouped = useMemo(() => {
    const out = new Map<Continent, Map<string, StarlinkReseller[]>>();
    for (const r of filtered) {
      if (!out.has(r.continent)) out.set(r.continent, new Map());
      const byCountry = out.get(r.continent)!;
      if (!byCountry.has(r.country)) byCountry.set(r.country, []);
      byCountry.get(r.country)!.push(r);
    }
    return out;
  }, [filtered]);

  return (
    <Card
      title={
        <div className="flex items-center gap-2">
          <Store size={14} /> Authorized retailers ({filtered.length} of {resellers.length})
        </div>
      }
    >
      <div className="flex flex-wrap gap-2 items-center mb-3">
        <div className="relative flex-1 min-w-[180px]">
          <Search
            size={14}
            className="absolute top-1/2 -translate-y-1/2 start-2.5 text-slate-500"
          />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search reseller, country…"
            className="w-full bg-surface-deep border border-slate-700 rounded-lg ps-8 pe-2 py-1.5 text-sm focus:border-brand outline-none"
          />
        </div>
        <select
          value={continentFilter}
          onChange={(e) => setContinentFilter(e.target.value as Continent | '')}
          className="bg-surface-deep border border-slate-700 rounded-lg px-2 py-1.5 text-sm focus:border-brand"
        >
          <option value="">All continents</option>
          {CONTINENT_ORDER.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
      </div>

      {filtered.length === 0 ? (
        <EmptyState
          icon={<Store size={28} />}
          title={resellers.length === 0 ? 'Loading reseller list…' : 'No resellers match.'}
        />
      ) : (
        <div className="space-y-5 max-h-[60vh] overflow-y-auto pe-1">
          {CONTINENT_ORDER.filter((c) => grouped.has(c)).map((continent) => {
            const byCountry = grouped.get(continent)!;
            const continentTotal = Array.from(byCountry.values()).reduce(
              (s, arr) => s + arr.length,
              0
            );
            return (
              <section key={continent}>
                <h3 className="text-base font-bold text-brand sticky top-0 bg-surface py-1 -mx-1 px-1">
                  {continent} <span className="text-slate-500 font-normal">· {continentTotal}</span>
                </h3>
                <div className="space-y-3 mt-2">
                  {Array.from(byCountry.entries())
                    .sort(([a], [b]) => a.localeCompare(b))
                    .map(([country, items]) => (
                      <div key={`${continent}-${country}`}>
                        <h4 className="text-sm font-semibold text-slate-200 mb-1">
                          {country}{' '}
                          <span className="text-xs text-slate-500 font-normal">
                            ({items.length})
                          </span>
                        </h4>
                        <ul className="ms-4 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-x-3 gap-y-0.5">
                          {items.map((r) => (
                            <li key={r.id} className="text-sm text-slate-300 flex items-start gap-1.5">
                              <span className="text-slate-500 mt-1">•</span>
                              <span className="flex-1">
                                {r.website ? (
                                  <a
                                    href={r.website}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="hover:text-brand underline-offset-2 hover:underline"
                                  >
                                    {r.name}
                                  </a>
                                ) : (
                                  r.name
                                )}
                                {r.notes && (
                                  <span
                                    className="ms-1 inline-flex items-center gap-1 text-[10px] text-priority-medium"
                                    title={r.notes}
                                  >
                                    <AlertCircle size={10} />
                                  </span>
                                )}
                              </span>
                            </li>
                          ))}
                        </ul>
                      </div>
                    ))}
                </div>
              </section>
            );
          })}
        </div>
      )}

      <p className="text-[11px] text-slate-500 mt-3 pt-2 border-t border-slate-700">
        Source:{' '}
        <a
          href={OFFICIAL_RESELLERS_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="text-brand underline"
        >
          starlink.com/support/article/8a90222d…
        </a>
        . Edit{' '}
        <code className="bg-surface-light px-1 rounded">public/data/starlink-resellers.json</code>{' '}
        in the repo to add or correct entries — the app re-fetches once an hour.
      </p>
    </Card>
  );
}

// =========================================================================
// Helpers
// =========================================================================

function formatRelative(date: Date): string {
  const diffMs = Date.now() - date.getTime();
  const m = Math.round(diffMs / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  if (d < 30) return `${d}d ago`;
  return date.toLocaleDateString();
}
