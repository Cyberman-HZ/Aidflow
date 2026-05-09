import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Cog, AlertTriangle, CheckCircle2, Trash2, Upload, Smartphone, ExternalLink } from 'lucide-react';
import { useLiveQuery } from 'dexie-react-hooks';
import { useSettingsStore } from '@/stores/settingsStore';
import { useConnectivityStore } from '@/stores/connectivityStore';
import { useAuthStore } from '@/stores/authStore';
import { Card } from '@/components/Card';
import LanguageSwitcher from '@/components/LanguageSwitcher';
import { reseed } from '@/db/seedData';
import { pingOllama } from '@/services/ollama';
import { uploadApk, deleteApk, formatBytes, getApkInfo, OFFICIAL_LINKS } from '@/services/bitchat';

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
        <div className="mt-5 pt-4 border-t border-slate-700 space-y-2">
          <div className="text-xs text-slate-400 font-medium uppercase tracking-wider">
            {t('settings.appearance') ?? 'Appearance'}
          </div>
          <div className="grid grid-cols-3 gap-2">
            {(['light', 'dark', 'system'] as const).map((opt) => (
              <button
                key={opt}
                type="button"
                onClick={() => settings.setTheme(opt)}
                className={`touch-target px-3 py-2 rounded-lg text-sm border transition-colors ${
                  settings.theme === opt
                    ? 'bg-brand text-white border-brand'
                    : 'bg-surface-deep border-slate-700 hover:bg-surface-light text-slate-200'
                }`}
                aria-pressed={settings.theme === opt}
              >
                {t(`theme.${opt}`) ??
                  (opt === 'light' ? 'Light' : opt === 'dark' ? 'Dark' : 'System')}
              </button>
            ))}
          </div>
        </div>
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

      <BitchatApkSection />

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

      {/* Attribution + non-affiliation notice — required by the Gemma model
          variant naming & attribution guidelines (see /uploads/External_
          Gemma_Model_Variant_Guidelines.pdf). The trademark line is the
          one Google specifies verbatim; the non-affiliation sentence
          clarifies that AidFlow Pro is independently built. */}
      <Card title={t('settings.about') ?? 'About'}>
        <div className="space-y-2 text-sm text-slate-300 leading-relaxed">
          <p>
            <strong>AidFlow Pro</strong> v1.0.0 —{' '}
            {t('settings.about_tagline') ??
              'AI-powered humanitarian aid distribution platform, built for the Gemma 4 Good Hackathon.'}
          </p>
          <p className="text-xs text-slate-400">
            {t('settings.about_model') ??
              'Inference is powered by Gemma 4 E4B running locally via Ollama. Embeddings (when available) use nomic-embed-text. The app is fully offline-first; no family data ever leaves the device.'}
          </p>
          <div className="pt-3 mt-3 border-t border-slate-700 text-xs text-slate-400 space-y-1">
            <p>
              {t('settings.gemma_trademark') ??
                'Gemma is a trademark of Google LLC.'}
            </p>
            <p>
              {t('settings.about_disclaimer') ??
                'AidFlow Pro is independently developed and is not affiliated with, endorsed by, or sponsored by Google.'}
            </p>
            <p>
              {t('settings.about_license') ??
                'AidFlow Pro source: MIT License. Gemma model weights: governed by Google\'s Gemma Terms of Use.'}
            </p>
          </div>
        </div>
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

// =========================================================================
// Bitchat APK upload (admin-only)
// =========================================================================

function BitchatApkSection() {
  const { t } = useTranslation();
  const user = useAuthStore((s) => s.user);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [version, setVersion] = useState('');
  const [pendingFile, setPendingFile] = useState<File | null>(null);

  const apkInfo = useLiveQuery(() => getApkInfo('bitchat-android'), []);

  // Hide entirely for non-admin / non-data_manager users
  if (!user) return null;
  const canUpload = user.role === 'admin' || user.role === 'data_manager';
  if (!canUpload && !apkInfo) return null;

  const onPick = (f: File) => {
    if (!f.name.toLowerCase().endsWith('.apk')) {
      alert('Please choose a .apk file');
      return;
    }
    setPendingFile(f);
    // Try to extract a version-like substring from the filename
    const m = f.name.match(/(\d+\.\d+(?:\.\d+)?)/);
    if (m) setVersion(m[1]);
  };

  const onUpload = async () => {
    if (!pendingFile || !user) return;
    setBusy(true);
    try {
      await uploadApk(pendingFile, {
        app: 'bitchat-android',
        version: version || 'unknown',
        uploaded_by: user.user_id,
        release_url: OFFICIAL_LINKS.androidReleases,
      });
      setPendingFile(null);
      setVersion('');
      if (fileInputRef.current) fileInputRef.current.value = '';
    } catch (e) {
      alert((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const onDelete = async () => {
    if (!confirm('Delete the uploaded Bitchat APK? Field teams will lose offline access.')) return;
    await deleteApk('bitchat-android');
  };

  return (
    <Card
      title={
        <div className="flex items-center gap-2">
          <Smartphone size={14} /> {t('chat.settings_section')}
        </div>
      }
    >
      <p className="text-sm text-slate-400 mb-4">
        {t('chat.settings_help', { url: '' }).replace('{{url}}', '')}
        <a
          href={OFFICIAL_LINKS.androidReleases}
          target="_blank"
          rel="noopener noreferrer"
          className="text-brand underline inline-flex items-center gap-1 ms-1"
        >
          github.com/permissionlesstech/bitchat-android <ExternalLink size={11} />
        </a>
      </p>

      {apkInfo ? (
        <div className="bg-priority-normal/10 border border-priority-normal/30 rounded-lg p-3 mb-4 flex items-start gap-3">
          <CheckCircle2 size={18} className="text-priority-normal flex-shrink-0 mt-0.5" />
          <div className="flex-1 text-sm">
            <div className="font-semibold text-priority-normal">{t('chat.uploaded_apk')}</div>
            <div className="text-xs text-slate-400 mt-1 space-y-0.5">
              <div>
                <span className="font-medium text-slate-300">{apkInfo.filename}</span>
              </div>
              <div>
                {t('chat.version_label')}: v{apkInfo.version} · {formatBytes(apkInfo.size_bytes)}
              </div>
              <div>
                Uploaded {new Date(apkInfo.uploaded_at).toLocaleString()}{' '}
                {apkInfo.uploaded_by && `by ${apkInfo.uploaded_by}`}
              </div>
            </div>
          </div>
          {canUpload && (
            <button
              onClick={() => void onDelete()}
              className="touch-target p-2 hover:bg-priority-critical/10 hover:text-priority-critical text-slate-500 rounded-lg"
              aria-label={t('chat.delete_apk')}
              title={t('chat.delete_apk')}
            >
              <Trash2 size={16} />
            </button>
          )}
        </div>
      ) : (
        canUpload && (
          <p className="text-xs text-slate-500 mb-3">
            No APK uploaded yet. Pick the .apk you downloaded from the official releases.
          </p>
        )
      )}

      {canUpload && (
        <div className="space-y-3">
          <input
            ref={fileInputRef}
            type="file"
            accept=".apk,application/vnd.android.package-archive"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) onPick(f);
            }}
            className="block w-full text-sm text-slate-300 file:mr-3 file:py-2 file:px-3 file:rounded-lg file:border-0 file:text-xs file:font-semibold file:bg-surface-light file:text-slate-200 hover:file:bg-slate-600"
          />
          {pendingFile && (
            <>
              <div className="flex items-center justify-between text-xs bg-surface-light px-3 py-2 rounded">
                <span className="truncate">
                  {pendingFile.name} · {formatBytes(pendingFile.size)}
                </span>
              </div>
              <Field
                label={`${t('chat.version_label')} (e.g. 1.4.2)`}
                value={version}
                onChange={setVersion}
                placeholder="1.0.0"
              />
              <button
                onClick={() => void onUpload()}
                disabled={busy}
                className="touch-target px-4 py-2 bg-brand hover:bg-brand-dark disabled:opacity-50 rounded-lg text-sm font-semibold flex items-center gap-2"
              >
                <Upload size={14} />
                {busy ? '…' : t('chat.upload_apk')}
              </button>
            </>
          )}
        </div>
      )}
    </Card>
  );
}
