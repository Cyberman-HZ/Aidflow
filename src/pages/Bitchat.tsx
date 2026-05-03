import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  MessageSquare,
  Bluetooth,
  BluetoothOff,
  Send,
  Wifi,
  Plus,
  Hash,
} from 'lucide-react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '@/db/database';
import { Card } from '@/components/Card';
import EmptyState from '@/components/EmptyState';
import { getStatus, scanAndConnect, send } from '@/services/bitchat';
import { useAuthStore } from '@/stores/authStore';
import type { BitchatTransportStatus } from '@/services/bitchat';

export default function Bitchat() {
  const { t } = useTranslation();
  const user = useAuthStore((s) => s.user);

  const [channel, setChannel] = useState('#sector-b-north');
  const [draft, setDraft] = useState('');
  const [status, setStatus] = useState<BitchatTransportStatus | null>(null);

  const messages = useLiveQuery(
    () => db.messages.where('channel').equals(channel).sortBy('sent_at'),
    [channel]
  ) ?? [];
  const allChannels = useLiveQuery(async () => {
    const all = await db.messages.toArray();
    return Array.from(new Set(all.map((m) => m.channel))).sort();
  }) ?? ['#sector-b-north', '#medical-team'];

  useEffect(() => {
    void getStatus().then(setStatus);
  }, []);

  const refreshStatus = async () => setStatus(await getStatus());

  const onScan = async () => {
    try {
      await scanAndConnect();
      await refreshStatus();
    } catch (e) {
      alert((e as Error).message);
    }
  };

  const onSend = async () => {
    if (!draft.trim() || !user) return;
    await send(channel, user.name, draft.trim());
    setDraft('');
  };

  const newChannel = async () => {
    const name = prompt('New channel name (e.g. #relief-coordination):');
    if (name) setChannel(name.startsWith('#') ? name : `#${name}`);
  };

  return (
    <div className="space-y-5 h-[calc(100vh-10rem)] flex flex-col">
      <header>
        <h1 className="text-2xl font-bold flex items-center gap-2">
          <MessageSquare size={22} />
          {t('chat.title')}
        </h1>
      </header>

      {status && !status.webBluetoothSupported && (
        <Card className="bg-priority-high/10 border-priority-high/30">
          <div className="flex items-center gap-2 text-sm text-priority-high">
            <BluetoothOff size={16} />
            {t('chat.no_bluetooth')}
          </div>
        </Card>
      )}

      <div className="flex-1 grid grid-cols-1 md:grid-cols-[200px_1fr] gap-4 min-h-0">
        <aside className="bg-surface border border-slate-700 rounded-xl p-3 flex flex-col">
          <div className="flex items-center justify-between mb-2">
            <h2 className="text-xs font-semibold text-slate-400 uppercase">Channels</h2>
            <button
              onClick={() => void newChannel()}
              className="text-slate-400 hover:text-brand"
              aria-label="New channel"
            >
              <Plus size={14} />
            </button>
          </div>
          <ul className="space-y-1 flex-1 overflow-y-auto">
            {allChannels.map((c) => (
              <li key={c}>
                <button
                  onClick={() => setChannel(c)}
                  className={`w-full text-start text-sm px-2 py-1.5 rounded flex items-center gap-1.5 ${
                    c === channel
                      ? 'bg-brand text-white'
                      : 'text-slate-300 hover:bg-surface-light'
                  }`}
                >
                  <Hash size={12} />
                  {c.replace('#', '')}
                </button>
              </li>
            ))}
          </ul>

          <div className="mt-3 pt-3 border-t border-slate-700 space-y-2 text-xs">
            <div className="flex items-center gap-2">
              {status?.bluetoothAvailable ? (
                <Bluetooth size={12} className="text-priority-normal" />
              ) : (
                <BluetoothOff size={12} className="text-slate-500" />
              )}
              <span className="text-slate-400">
                {status?.connectedDevice
                  ? t('chat.connected', { name: status.connectedDevice })
                  : 'Not paired'}
              </span>
            </div>
            <div className="flex items-center gap-2">
              <Wifi size={12} className={status?.online ? 'text-priority-normal' : 'text-slate-500'} />
              <span className="text-slate-400">{status?.online ? 'Online' : 'Offline'}</span>
            </div>
            <button
              onClick={() => void onScan()}
              disabled={!status?.webBluetoothSupported}
              className="w-full mt-1 px-2 py-1.5 bg-surface-light hover:bg-slate-600 disabled:opacity-50 rounded text-xs"
            >
              {t('chat.scan')}
            </button>
          </div>
        </aside>

        <main className="bg-surface border border-slate-700 rounded-xl flex flex-col min-h-0">
          <div className="px-4 py-2 border-b border-slate-700 text-sm font-medium">
            <Hash size={14} className="inline me-1 text-slate-500" />
            {channel.replace('#', '')}
          </div>
          <div className="flex-1 overflow-y-auto p-4 space-y-3">
            {messages.length === 0 ? (
              <EmptyState title={t('chat.no_messages')} />
            ) : (
              messages.map((m) => (
                <div key={m.msg_id} className="flex flex-col">
                  <div className="text-xs text-slate-400">
                    <span className="font-medium text-slate-200">{m.author}</span> ·{' '}
                    {new Date(m.sent_at).toLocaleTimeString([], {
                      hour: '2-digit',
                      minute: '2-digit',
                    })}{' '}
                    ·{' '}
                    <span
                      className={
                        m.delivered_via === 'queued'
                          ? 'text-priority-medium'
                          : m.delivered_via === 'bluetooth'
                          ? 'text-brand'
                          : 'text-priority-normal'
                      }
                    >
                      {m.delivered_via === 'bluetooth'
                        ? t('chat.via_bluetooth')
                        : m.delivered_via === 'nostr'
                        ? t('chat.via_nostr')
                        : t('chat.queued')}
                    </span>
                  </div>
                  <div className="bg-surface-light px-3 py-2 rounded-lg max-w-[85%] mt-0.5">
                    {m.body}
                  </div>
                </div>
              ))
            )}
          </div>
          <div className="border-t border-slate-700 p-3 flex gap-2">
            <input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  void onSend();
                }
              }}
              placeholder={t('chat.message_placeholder')}
              className="flex-1 bg-surface-deep border border-slate-700 rounded-lg px-3 py-2 text-sm focus:border-brand outline-none touch-target"
            />
            <button
              onClick={() => void onSend()}
              disabled={!draft.trim()}
              className="touch-target px-4 py-2 bg-brand hover:bg-brand-dark disabled:opacity-50 rounded-lg flex items-center gap-1 font-semibold"
            >
              <Send size={16} />
              <span className="hidden sm:inline">{t('chat.send')}</span>
            </button>
          </div>
        </main>
      </div>
    </div>
  );
}
