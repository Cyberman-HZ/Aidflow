import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Wifi, WifiOff, CloudOff } from 'lucide-react';
import { useConnectivityStore } from '@/stores/connectivityStore';

export default function ConnectivityBanner() {
  const { t } = useTranslation();
  const { state, refresh } = useConnectivityStore();

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const cfg = {
    online: { bg: 'bg-emerald-600', icon: <Wifi size={16} />, label: t('connectivity.online') },
    local: { bg: 'bg-warn', icon: <WifiOff size={16} />, label: t('connectivity.local') },
    disconnected: {
      bg: 'bg-red-600',
      icon: <CloudOff size={16} />,
      label: t('connectivity.disconnected'),
    },
  }[state];

  return (
    <div
      className={`${cfg.bg} text-white text-xs sm:text-sm font-medium flex items-center justify-center gap-2 px-3 py-1.5`}
      role="status"
      aria-live="polite"
    >
      {cfg.icon}
      <span>{cfg.label}</span>
      {state === 'disconnected' && (
        <span className="hidden sm:inline opacity-90 ms-2">
          · {t('connectivity.ollama_down')}
        </span>
      )}
    </div>
  );
}
