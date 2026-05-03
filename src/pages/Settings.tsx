import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Cog, AlertTriangle, CheckCircle2, Trash2 } from 'lucide-react';
import { useSettingsStore } from '@/stores/settingsStore';
import { useConnectivityStore } from '@/stores/connectivityStore';
import { Card } from '@/components/Card';
import LanguageSwitcher from '@/components/LanguageSwitcher';
import { reseed } from '@/db/seedData';
import { pingOllama } from '@/services/ollama';

export default function Settings() {
  const { t } = useTranslation();
  const settings = useSettingsStore();
  const refreshConn = useConnectivityStore((s) => s.refresh);

  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);

  const test = async () => {
    setTesting(true);
    try {
      const ok = await pingOllama();
      setTestResult({
        ok,
        message: ok
          ? t('settings.connection_ok', { model: settings.ollamaModel })
          : t('settings.connection_fail'),
      });
      await refreshConn();
    } finally {
      setTesting(false);
    }
  };

  const onReset = async () => {
    if (!confirm(t('settings.reset_confirm'))) return;
    await reseed();
    location.reload();
  };

  return (
    <div className="space-y-5">
      <header>
        <h1 className="text-2xl font-bold flex items-center gap-2">
          <Cog size={22} />
          {t('settings.title')}
        </h1>
      </header>

      <Card title={t('settings.language')}>
        <LanguageSwitcher />
        <label className="mt-4 flex items-center gap-2 text-sm cursor-pointer">
          <input
            type="checkbox"
            checked={settings.darkMode}
            onChange={(e) => settings.setDarkMode(e.target.checked)}
            className="accent-brand"
          />
          {t('settings.dark_mode')}
        </label>
      </Card>

      <Card title={t('settings.ai_section')}>
        <div className="space-y-3">
          <Field
            label={t('settings.ollama_url')}
            value={settings.ollamaBaseUrl}
            onChange={settings.setOllamaBaseUrl}
            placeholder="http://localhost:11434"
          />
          <Field
            label={t('settings.ollama_model')}
            value={settings.ollamaModel}
            onChange={settings.setOllamaModel}
            placeholder="gemma4:e4b"
          />
          <Field
            label={t('settings.embed_model')}
            value={settings.embedModel}
            onChange={settings.setEmbedModel}
            placeholder="nomic-embed-text"
          />
          <button
            onClick={() => void test()}
            disabled={testing}
            className="touch-target px-4 py-2 bg-ai hover:bg-violet-600 disabled:opacity-50 rounded-lg text-sm font-semibold"
          >
            {testing ? '…' : t('settings.test_connection')}
          </button>
          {testResult && (
            <div
              className={`flex items-start gap-2 text-sm p-3 rounded-lg ${
                testResult.ok
                  ? 'bg-priority-normal/10 text-priority-normal border border-priority-normal/30'
                  : 'bg-priority-critical/10 text-priority-critical border border-priority-critical/30'
              }`}
            >
              {testResult.ok ? <CheckCircle2 size={16} /> : <AlertTriangle size={16} />}
              <span>{testResult.message}</span>
            </div>
          )}
          <p className="text-xs text-slate-400 leading-relaxed">
            <strong>Heads-up:</strong> Start Ollama with{' '}
            <code className="bg-surface-light px-1 rounded">OLLAMA_ORIGINS=*</code> so the browser
            can reach it. On Windows PowerShell:{' '}
            <code className="bg-surface-light px-1 rounded">$env:OLLAMA_ORIGINS="*"; ollama serve</code>.
          </p>
        </div>
      </Card>

      <Card title={t('settings.data_section')}>
        <p className="text-sm text-slate-400 mb-3">
          All data lives locally in IndexedDB. Resetting only affects this device.
        </p>
        <button
          onClick={() => void onReset()}
          className="touch-target px-4 py-2 bg-priority-critical/10 text-priority-critical hover:bg-priority-critical/20 border border-priority-critical/30 rounded-lg text-sm font-semibold flex items-center gap-2"
        >
          <Trash2 size={14} />
          {t('settings.reset_demo')}
        </button>
      </Card>
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  return (
    <div>
      <label className="block text-xs text-slate-400 mb-1 font-medium">{label}</label>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-full bg-surface-deep border border-slate-700 rounded-lg px-3 py-2 text-sm focus:border-brand outline-none font-mono"
      />
    </div>
  );
}
