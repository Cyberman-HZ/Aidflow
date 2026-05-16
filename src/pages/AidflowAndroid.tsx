// AidFlow Android — Beta companion-app distribution page.
//
// One tab that does three things:
//   1. Explains what the Android app is + what it does.
//   2. Lets any user download the uploaded .apk for offline install.
//   3. Lets admin / data_manager upload a new .apk that replaces the
//      previous one. The blob lives in IndexedDB so field teams pull
//      it from the same AidFlow Pro instance even when offline.
//
// The Android app's own repo (source + beta releases) is linked at
// the top.

import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Smartphone,
  Download,
  Upload,
  ExternalLink,
  CheckCircle2,
  AlertTriangle,
  Trash2,
  Camera,
  Languages,
  FileText,
  ScanText,
  Package,
  ShieldCheck,
} from 'lucide-react';
import { useLiveQuery } from 'dexie-react-hooks';
import { Card } from '@/components/Card';
import {
  uploadApk,
  getApkInfo,
  downloadApk,
  deleteApk,
  formatBytes,
  AIDFLOW_ANDROID_REPO,
} from '@/services/aidflowAndroid';
import { useAuthStore } from '@/stores/authStore';

// Drop screenshots in public/screenshots/aidflow-android/ with these
// filenames. Missing files render a small "not yet added" placeholder
// via the <img onError> handler — the page never breaks on a 404.
const SCREENSHOTS: ReadonlyArray<{ src: string; alt: string }> = [
  { src: '/screenshots/aidflow-android/01.png', alt: 'AidFlow Android — screenshot 1' },
  { src: '/screenshots/aidflow-android/02.png', alt: 'AidFlow Android — screenshot 2' },
  { src: '/screenshots/aidflow-android/03.png', alt: 'AidFlow Android — screenshot 3' },
  { src: '/screenshots/aidflow-android/04.png', alt: 'AidFlow Android — screenshot 4' },
  { src: '/screenshots/aidflow-android/05.png', alt: 'AidFlow Android — screenshot 5' },
  { src: '/screenshots/aidflow-android/06.png', alt: 'AidFlow Android — screenshot 6' },
];

export default function AidflowAndroid() {
  const { t } = useTranslation();
  const user = useAuthStore((s) => s.user);
  const apkInfo = useLiveQuery(() => getApkInfo(), []);

  const canUpload = user?.role === 'admin' || user?.role === 'data_manager';

  return (
    <div className="space-y-5">
      <header>
        <h1 className="text-2xl font-bold flex items-center gap-2 flex-wrap">
          <Smartphone size={22} />
          {t('aidflow_android.title', 'AidFlow Android App')}
          <span className="text-[10px] font-semibold uppercase tracking-wider bg-ai/15 text-ai border border-ai/30 rounded-full px-2 py-0.5">
            {t('aidflow_android.beta', 'Beta')}
          </span>
        </h1>
        <p className="text-sm text-slate-400 mt-1">
          {t(
            'aidflow_android.subtitle',
            'Field-worker companion: voice + photo intake, document scanning, 20-language translation, and offline Excel export. Powered by Gemma 4 E2B on-device.'
          )}
        </p>
        <a
          href={AIDFLOW_ANDROID_REPO}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 text-xs text-brand hover:underline mt-2"
        >
          {t('aidflow_android.view_repo', 'View source on GitHub')}
          <ExternalLink size={11} />
        </a>
      </header>

      {/* ---------- About / features ---------------------------------- */}
      <Card>
        <h2 className="font-semibold text-slate-100 mb-3">
          {t('aidflow_android.features_title', 'What it does')}
        </h2>
        <ul className="space-y-2 text-sm text-slate-300">
          <li className="flex items-start gap-2">
            <Camera size={16} className="text-ai flex-shrink-0 mt-0.5" />
            <span>
              <strong>Voice + photo family intake.</strong> Worker speaks or photographs a
              registration; Gemma 4 vision and on-device speech extract a structured family
              record matching the AidFlow Pro schema (head name, member count, children under
              five, displacement, income, medical conditions).
            </span>
          </li>
          <li className="flex items-start gap-2">
            <Package size={16} className="text-ai flex-shrink-0 mt-0.5" />
            <span>
              <strong>Relief-item identification from photos.</strong> Snap a stack of
              supplies; the model identifies items with category and estimated quantity for
              fast inventory entry.
            </span>
          </li>
          <li className="flex items-start gap-2">
            <ScanText size={16} className="text-ai flex-shrink-0 mt-0.5" />
            <span>
              <strong>Document scanning with OCR.</strong> Multi-page scans get auto-cropped,
              perspective-corrected, OCR'd, cleaned, and translated end-to-end. Built-in
              camera handles lens and flash control.
            </span>
          </li>
          <li className="flex items-start gap-2">
            <Languages size={16} className="text-ai flex-shrink-0 mt-0.5" />
            <span>
              <strong>Real-time translation across 20 languages</strong> — voice and text
              both. English, Spanish, French, Arabic, Ukrainian, Russian, Polish, Turkish,
              Persian, Pashto, Urdu, Hindi, Bengali, Swahili, Amharic, Somali, Chinese
              (Simplified), Vietnamese, Tagalog.
            </span>
          </li>
          <li className="flex items-start gap-2">
            <FileText size={16} className="text-ai flex-shrink-0 mt-0.5" />
            <span>
              <strong>Excel / CSV / DOCX / TXT export</strong> with column headers matching
              the AidFlow Pro schema. Hand off the file over USB / Bluetooth / local Wi-Fi
              and import it through the web-app's spreadsheet wizard.
            </span>
          </li>
          <li className="flex items-start gap-2">
            <ShieldCheck size={16} className="text-priority-normal flex-shrink-0 mt-0.5" />
            <span>
              <strong>Offline-first.</strong> Zero network calls after the one-time ~2.6 GB
              model download. No data ever leaves the device.
            </span>
          </li>
        </ul>
      </Card>

      {/* ---------- Device requirements ------------------------------- */}
      <Card>
        <h2 className="font-semibold text-slate-100 mb-3">
          {t('aidflow_android.requirements_title', 'Device requirements')}
        </h2>
        <ul className="space-y-1.5 text-sm text-slate-300 list-disc list-inside">
          <li>{t('aidflow_android.req_android', 'Android 12+ (API 31). Voice translation optimized for Android 13+.')}</li>
          <li>{t('aidflow_android.req_storage', '3 GB free storage (model file is ~2.6 GB).')}</li>
          <li>{t('aidflow_android.req_ram', '2 GB free RAM.')}</li>
          <li>{t('aidflow_android.req_first_launch', 'First launch: 60–90 seconds to load the model. Subsequent launches: ~15 seconds.')}</li>
        </ul>
      </Card>

      {/* ---------- Download (visible to everyone) -------------------- */}
      <Card>
        <h2 className="font-semibold text-slate-100 mb-3 flex items-center gap-2">
          <Download size={18} />
          {t('aidflow_android.download_title', 'Download APK')}
        </h2>

        {apkInfo ? (
          <>
            <div className="bg-priority-normal/10 border border-priority-normal/30 rounded-lg p-3 mb-4 flex items-start gap-3">
              <CheckCircle2 size={18} className="text-priority-normal flex-shrink-0 mt-0.5" />
              <div className="flex-1 text-sm">
                <div className="font-semibold text-priority-normal">
                  {t('aidflow_android.apk_ready', 'APK ready for offline install')}
                </div>
                <div className="text-xs text-slate-400 mt-1 space-y-0.5">
                  <div><span className="font-medium text-slate-300">{apkInfo.filename}</span></div>
                  <div>
                    {t('aidflow_android.version_label', 'Version')}: v{apkInfo.version} ·{' '}
                    {formatBytes(apkInfo.size_bytes)}
                  </div>
                  <div>
                    {t('aidflow_android.uploaded_label', 'Uploaded')}{' '}
                    {new Date(apkInfo.uploaded_at).toLocaleString()}
                    {apkInfo.uploaded_by ? ` · ${apkInfo.uploaded_by}` : ''}
                  </div>
                </div>
              </div>
            </div>
            <DownloadButton />
          </>
        ) : (
          <div className="bg-surface-light/40 border border-slate-700 rounded-lg p-4 text-sm text-slate-400 flex items-start gap-2">
            <AlertTriangle size={16} className="text-priority-medium flex-shrink-0 mt-0.5" />
            <span>
              {t(
                'aidflow_android.no_apk',
                'No APK uploaded yet. An organisation admin must upload the .apk file once while online; field teams can then download it offline from this page.'
              )}
            </span>
          </div>
        )}
      </Card>

      {/* ---------- Upload (admin / data_manager only) ---------------- */}
      {canUpload && <UploadSection hasExisting={!!apkInfo} />}

      {/* ---------- Install steps ------------------------------------- */}
      <Card>
        <h2 className="font-semibold text-slate-100 mb-3">
          {t('aidflow_android.install_title', 'Install on Android')}
        </h2>
        <ol className="space-y-2 text-sm text-slate-300 list-decimal list-inside">
          <li>{t('aidflow_android.install_step1', 'Tap the Download button above to save the .apk file to your phone.')}</li>
          <li>{t('aidflow_android.install_step2', 'In Android Settings → Apps → Special access → Install unknown apps, enable your browser to install APKs.')}</li>
          <li>{t('aidflow_android.install_step3', 'Open your Downloads folder, tap the .apk, then tap Install.')}</li>
          <li>{t('aidflow_android.install_step4', 'On first launch, allow the ~2.6 GB Gemma 4 E2B model download (Wi-Fi recommended).')}</li>
          <li>{t('aidflow_android.install_step5', 'Grant camera + microphone permissions when prompted — both are used on-device only.')}</li>
        </ol>
      </Card>

      {/* ---------- Screenshots gallery ------------------------------- */}
      <Card>
        <h2 className="font-semibold text-slate-100 mb-3">
          {t('aidflow_android.screenshots_title', 'Screenshots')}
        </h2>
        <p className="text-xs text-slate-500 mb-3">
          {t(
            'aidflow_android.screenshots_hint',
            'Drop screenshots into public/screenshots/aidflow-android/ named 01.png … 06.png. Missing files show a placeholder.'
          )}
        </p>
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-6 gap-3">
          {SCREENSHOTS.map((s) => (
            <ScreenshotTile key={s.src} src={s.src} alt={s.alt} />
          ))}
        </div>
      </Card>
    </div>
  );
}

// =========================================================================
// Download button
// =========================================================================

function DownloadButton() {
  const { t } = useTranslation();
  const [downloading, setDownloading] = useState(false);

  const onDownload = async () => {
    setDownloading(true);
    try {
      await downloadApk();
    } catch (e) {
      alert((e as Error).message);
    } finally {
      setDownloading(false);
    }
  };

  return (
    <button
      onClick={() => void onDownload()}
      disabled={downloading}
      className="touch-target px-4 py-2 bg-ai hover:bg-violet-600 disabled:opacity-50 text-white text-sm font-semibold rounded-md flex items-center gap-2"
    >
      <Download size={14} />
      {downloading
        ? t('aidflow_android.downloading', 'Downloading…')
        : t('aidflow_android.download_button', 'Download .apk')}
    </button>
  );
}

// =========================================================================
// Upload section — admin / data_manager only
// =========================================================================

function UploadSection({ hasExisting }: { hasExisting: boolean }) {
  const { t } = useTranslation();
  const user = useAuthStore((s) => s.user);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [version, setVersion] = useState('');
  const [pendingFile, setPendingFile] = useState<File | null>(null);

  const onPick = (f: File) => {
    if (!f.name.toLowerCase().endsWith('.apk')) {
      alert('Please choose a .apk file');
      return;
    }
    setPendingFile(f);
    // Auto-fill version from filename if it looks like "…-1.2.3.apk".
    const m = f.name.match(/(\d+\.\d+(?:\.\d+)?)/);
    if (m) setVersion(m[1]);
  };

  const onUpload = async () => {
    if (!pendingFile || !user) return;
    setBusy(true);
    try {
      await uploadApk(pendingFile, {
        version: version || 'unknown',
        uploaded_by: user.user_id,
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
    if (
      !confirm(
        t(
          'aidflow_android.confirm_delete',
          'Delete the uploaded AidFlow Android APK? Field teams will lose offline access.'
        ) as string
      )
    )
      return;
    await deleteApk();
  };

  return (
    <Card
      title={
        <div className="flex items-center gap-2">
          <Upload size={14} />
          {t('aidflow_android.upload_title', 'Admin · Upload .apk')}
        </div>
      }
    >
      <p className="text-sm text-slate-400 mb-3">
        {t(
          'aidflow_android.upload_help',
          'Upload a new build of the AidFlow Android App so field teams can install it offline from this page. Uploading replaces the previous version.'
        )}
      </p>

      <div className="space-y-3">
        <input
          ref={fileInputRef}
          type="file"
          accept=".apk,application/vnd.android.package-archive"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) onPick(f);
          }}
          className="block text-sm text-slate-400 file:mr-3 file:py-1.5 file:px-3 file:rounded-md file:border-0 file:text-sm file:bg-surface-light file:text-slate-200 file:cursor-pointer hover:file:bg-slate-600"
        />

        {pendingFile && (
          <div className="space-y-2">
            <div className="text-xs text-slate-400">
              {pendingFile.name} · {formatBytes(pendingFile.size)}
            </div>
            <input
              type="text"
              value={version}
              onChange={(e) => setVersion(e.target.value)}
              placeholder={
                t('aidflow_android.version_placeholder', 'Version (e.g. 0.1.2)') as string
              }
              className="w-full bg-surface-deep border border-slate-700 rounded-md px-2 py-1.5 text-sm"
            />
            <button
              onClick={() => void onUpload()}
              disabled={busy}
              className="touch-target px-4 py-2 bg-brand hover:bg-brand-dark disabled:opacity-50 text-white text-sm font-semibold rounded-md flex items-center gap-2"
            >
              <Upload size={14} />
              {busy
                ? t('aidflow_android.uploading', 'Uploading…')
                : t('aidflow_android.upload_button', 'Upload')}
            </button>
          </div>
        )}

        {hasExisting && (
          <button
            onClick={() => void onDelete()}
            className="touch-target text-xs text-priority-critical hover:underline flex items-center gap-1"
          >
            <Trash2 size={12} />
            {t('aidflow_android.delete_button', 'Delete current APK')}
          </button>
        )}
      </div>
    </Card>
  );
}

// =========================================================================
// Screenshot tile — gracefully shows a placeholder for missing files
// =========================================================================

function ScreenshotTile({ src, alt }: { src: string; alt: string }) {
  const [failed, setFailed] = useState(false);
  if (failed) {
    return (
      <figure className="rounded-lg overflow-hidden border border-dashed border-slate-700 bg-surface-light/40 aspect-[9/16] flex items-center justify-center p-2">
        <span className="text-[10px] text-slate-500 text-center break-all">
          {src.split('/').pop()}
          <br />
          (not yet added)
        </span>
      </figure>
    );
  }
  return (
    <figure className="rounded-lg overflow-hidden border border-slate-700 bg-surface-light">
      <img
        src={src}
        alt={alt}
        className="w-full h-auto object-cover aspect-[9/16] bg-surface-deep"
        onError={() => setFailed(true)}
      />
    </figure>
  );
}
