import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { MapPin, Plus, Crosshair, Map as MapIcon } from 'lucide-react';
import { MapContainer, TileLayer, Marker, Popup, CircleMarker } from 'react-leaflet';
import L from 'leaflet';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '@/db/database';
import { Card } from '@/components/Card';
import type { StarlinkProvider } from '@/types';

// Fix Leaflet marker icon resolution under Vite
delete (L.Icon.Default.prototype as any)._getIconUrl;
L.Icon.Default.mergeOptions({
  iconRetinaUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png',
  iconUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png',
  shadowUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png',
});

const SIGNAL_COLOR = { strong: '#22c55e', moderate: '#eab308', weak: '#ef4444' } as const;
const SIGNAL_RADIUS = { strong: 18000, moderate: 12000, weak: 6000 } as const;

export default function StarlinkMap() {
  const { t } = useTranslation();
  const providers = useLiveQuery(() => db.providers.toArray(), []) ?? [];

  const [country, setCountry] = useState('');
  const [signal, setSignal] = useState('');
  const [center, setCenter] = useState<[number, number]>([20, 30]);
  const [zoom, setZoom] = useState(2);

  const countries = useMemo(
    () => Array.from(new Set(providers.map((p) => p.country))).sort(),
    [providers]
  );

  const filtered = providers.filter(
    (p) => (!country || p.country === country) && (!signal || p.signal === signal)
  );

  const locate = () => {
    if (!('geolocation' in navigator)) return;
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setCenter([pos.coords.latitude, pos.coords.longitude]);
        setZoom(8);
      },
      () => alert('Could not determine your location.')
    );
  };

  const addCustomPin = async () => {
    const name = prompt('Custom pin name?');
    if (!name) return;
    const region = prompt('Region / city?') ?? '';
    const provider: StarlinkProvider = {
      id: `CP-${Date.now()}`,
      name,
      country: country || 'Custom',
      region,
      type: 'service_point',
      lat: center[0],
      lng: center[1],
      signal: 'moderate',
      custom: true,
    };
    await db.providers.add(provider);
  };

  return (
    <div className="space-y-4">
      <header>
        <h1 className="text-2xl font-bold flex items-center gap-2">
          <MapIcon size={22} />
          {t('map.title')}
        </h1>
        <p className="text-sm text-slate-400 mt-1">{t('map.subtitle')}</p>
      </header>

      <Card>
        <div className="flex flex-wrap gap-3 items-center">
          <select
            value={country}
            onChange={(e) => setCountry(e.target.value)}
            className="bg-surface-deep border border-slate-700 rounded-lg px-3 py-2 text-sm touch-target"
          >
            <option value="">{t('map.filter_country')}</option>
            {countries.map((c) => (
              <option key={c} value={c}>{c}</option>
            ))}
          </select>
          <select
            value={signal}
            onChange={(e) => setSignal(e.target.value)}
            className="bg-surface-deep border border-slate-700 rounded-lg px-3 py-2 text-sm touch-target"
          >
            <option value="">{t('map.filter_signal')}</option>
            <option value="strong">{t('map.signal.strong')}</option>
            <option value="moderate">{t('map.signal.moderate')}</option>
            <option value="weak">{t('map.signal.weak')}</option>
          </select>
          <button
            onClick={locate}
            className="touch-target px-3 py-2 bg-surface-light hover:bg-slate-600 rounded-lg text-sm flex items-center gap-2"
          >
            <Crosshair size={14} /> {t('map.my_location')}
          </button>
          <button
            onClick={() => void addCustomPin()}
            className="touch-target px-3 py-2 bg-brand hover:bg-brand-dark rounded-lg text-sm flex items-center gap-2 ms-auto font-semibold"
          >
            <Plus size={14} /> {t('map.add_pin')}
          </button>
        </div>
      </Card>

      <div className="bg-surface rounded-xl border border-slate-700 overflow-hidden h-[60vh]">
        <MapContainer
          center={center}
          zoom={zoom}
          scrollWheelZoom
          style={{ height: '100%', width: '100%' }}
        >
          <TileLayer
            attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OSM</a>'
            url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
          />
          {filtered.map((p) => (
            <ProviderPin key={p.id} provider={p} />
          ))}
        </MapContainer>
      </div>

      <Card title={`Providers (${filtered.length})`}>
        <ul className="divide-y divide-slate-700">
          {filtered.map((p) => (
            <li key={p.id} className="py-2 flex items-center gap-3 text-sm">
              <span
                className="w-3 h-3 rounded-full"
                style={{ backgroundColor: SIGNAL_COLOR[p.signal] }}
              />
              <div className="flex-1">
                <div className="font-medium">{p.name}</div>
                <div className="text-xs text-slate-400">
                  {p.region}, {p.country} · {t(`map.type.${p.type}`)} · {t(`map.signal.${p.signal}`)}
                </div>
              </div>
              <a
                href={`https://www.openstreetmap.org/?mlat=${p.lat}&mlon=${p.lng}#map=12/${p.lat}/${p.lng}`}
                target="_blank"
                rel="noopener noreferrer"
                className="text-xs text-brand hover:underline"
              >
                {t('map.directions')}
              </a>
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}

function ProviderPin({ provider }: { provider: StarlinkProvider }) {
  const { t } = useTranslation();
  return (
    <>
      <CircleMarker
        center={[provider.lat, provider.lng]}
        radius={Math.max(8, SIGNAL_RADIUS[provider.signal] / 1000)}
        pathOptions={{
          color: SIGNAL_COLOR[provider.signal],
          fillColor: SIGNAL_COLOR[provider.signal],
          fillOpacity: 0.18,
          weight: 1,
        }}
      />
      <Marker position={[provider.lat, provider.lng]}>
        <Popup>
          <div className="text-sm space-y-1">
            <div className="font-semibold">{provider.name}</div>
            <div className="text-xs">
              {provider.region}, {provider.country}
            </div>
            <div className="text-xs">
              <strong>Type:</strong> {t(`map.type.${provider.type}`)}
            </div>
            <div className="text-xs">
              <strong>Signal:</strong>{' '}
              <span style={{ color: SIGNAL_COLOR[provider.signal] }}>
                {t(`map.signal.${provider.signal}`)}
              </span>
            </div>
            {provider.phone && <div className="text-xs">📞 {provider.phone}</div>}
            {provider.hours && <div className="text-xs">🕒 {provider.hours}</div>}
            <a
              href={`https://www.openstreetmap.org/?mlat=${provider.lat}&mlon=${provider.lng}#map=14/${provider.lat}/${provider.lng}`}
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs underline"
            >
              {t('map.directions')} →
            </a>
          </div>
        </Popup>
      </Marker>
    </>
  );
}
