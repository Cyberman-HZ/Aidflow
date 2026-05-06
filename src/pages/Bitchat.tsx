// Bitchat install guide — Android only.
//
// AidFlow Pro doesn't implement Bitchat in-browser (Web Bluetooth's
// Central-only restriction makes a full mesh peer impossible). Instead,
// this page walks field teams through installing the official native
// Bitchat Android app, with offline APK distribution for areas without
// internet.

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  MessageSquare,
  Smartphone,
  Download,
  Bluetooth,
  ShieldCheck,
  Settings as Cog,
  Hash,
  CheckCircle2,
  ExternalLink,
  Info,
} from 'lucide-react';
import { useLiveQuery } from 'dexie-react-hooks';
import { Card } from '@/components/Card';
import { downloadApk, getApkInfo, formatBytes, OFFICIAL_LINKS } from '@/services/bitchat';

export default function BitchatGuide() {
  const { t } = useTranslation();

  // Only pull the metadata (not the multi-MB blob) into the React tree.
  const apkInfo = useLiveQuery(() => getApkInfo('bitchat-android'), []);

  return (
    <div className="space-y-5">
      <header>
        <h1 className="text-2xl font-bold flex items-center gap-2">
          <MessageSquare size={22} />
          {t('chat.title')}
        </h1>
        <p className="text-sm text-slate-400 mt-1">{t('chat.guide_subtitle')}</p>
      </header>

      {/* Why install — single intro card */}
      <Card>
        <div className="flex items-start gap-3">
          <div className="text-ai mt-0.5">
            <Bluetooth size={22} />
          </div>
          <div className="flex-1">
            <h2 className="font-semibold text-slate-100 mb-1">{t('chat.why_title')}</h2>
            <p className="text-sm text-slate-300 leading-relaxed">{t('chat.why_body')}</p>
            <div className="mt-3 flex flex-wrap gap-3 text-xs">
              <a
                href={OFFICIAL_LINKS.repo}
                target="_blank"
                rel="noopener noreferrer"
                className="text-brand underline hover:text-sky-300 inline-flex items-center gap-1"
              >
                Official Bitchat repository <ExternalLink size={11} />
              </a>
              <a
                href={OFFICIAL_LINKS.whitepaper}
                target="_blank"
                rel="noopener noreferrer"
                className="text-brand underline hover:text-sky-300 inline-flex items-center gap-1"
              >
                Protocol whitepaper <ExternalLink size={11} />
              </a>
            </div>
          </div>
        </div>
      </Card>

      <AndroidGuide apkInfo={apkInfo} />

      {/* Test the mesh */}
      <Card>
        <h2 className="font-semibold text-slate-100 mb-2 flex items-center gap-2">
          <CheckCircle2 size={16} className="text-priority-normal" />
          {t('chat.test_title')}
        </h2>
        <ol className="text-sm text-slate-300 space-y-1.5 list-decimal list-inside">
          <li>{t('chat.test_step1')}</li>
          <li>{t('chat.test_step2')}</li>
          <li>{t('chat.test_step3')}</li>
          <li>{t('chat.test_step4')}</li>
        </ol>
      </Card>

      {/* Org recommendations */}
      <Card>
        <h2 className="font-semibold text-slate-100 mb-2 flex items-center gap-2">
          <Hash size={16} className="text-brand" />
          {t('chat.org_title')}
        </h2>
        <ul className="text-sm text-slate-300 space-y-1.5 list-disc list-inside">
          <li>{t('chat.org_rec1')}</li>
          <li>{t('chat.org_rec2')}</li>
          <li>{t('chat.org_rec3')}</li>
          <li>{t('chat.org_rec4')}</li>
        </ul>
      </Card>
    </div>
  );
}

// =========================================================================
// Android steps
// =========================================================================

function AndroidGuide({
  apkInfo,
}: {
  apkInfo: Omit<import('@/types').BitchatApk, 'data'> | null | undefined;
}) {
  const { t } = useTranslation();
  const [downloading, setDownloading] = useState(false);

  const onDownload = async () => {
    setDownloading(true);
    try {
      await downloadApk('bitchat-android');
    } catch (e) {
      alert((e as Error).message);
    } finally {
      setDownloading(false);
    }
  };

  return (
    <Card>
      <h2 className="font-semibold text-slate-100 mb-3 flex items-center gap-2">
        <Smartphone size={18} /> Android · {t('chat.install_steps')}
      </h2>

      {/* Two install paths side-by-side */}
      <div className="grid sm:grid-cols-2 gap-3 mb-4">
        <a
          href={OFFICIAL_LINKS.androidPlayStore}
          target="_blank"
          rel="noopener noreferrer"
          className="bg-surface-light hover:bg-slate-600 border border-slate-700 rounded-lg p-3 transition-colors"
        >
          <div className="flex items-center gap-2 mb-1">
            <Smartphone size={16} className="text-priority-normal" />
            <span className="font-semibold text-sm">Play Store (online)</span>
            <ExternalLink size={11} className="ms-auto text-slate-500" />
          </div>
          <p className="text-xs text-slate-400 leading-relaxed">
            Install bitchat from Google Play. Requires internet at install time but no
            security toggles, no manual APK handling.
          </p>
        </a>
        <div className="bg-surface-light border border-slate-700 rounded-lg p-3">
          <div className="flex items-center gap-2 mb-1">
            <Download size={16} className="text-ai" />
            <span className="font-semibold text-sm">APK sideload (offline)</span>
          </div>
          <p className="text-xs text-slate-400 leading-relaxed">
            Sideload the .apk hosted on this AidFlow server — works fully offline. Follow
            the steps below.
          </p>
        </div>
      </div>

      {/* Local APK status banner */}
      {apkInfo ? (
        <div className="bg-priority-normal/10 border border-priority-normal/30 rounded-lg p-3 mb-4 flex items-start gap-2 text-sm">
          <CheckCircle2 size={16} className="text-priority-normal flex-shrink-0 mt-0.5" />
          <div className="flex-1">
            <div className="font-semibold text-priority-normal">{t('chat.apk_ready')}</div>
            <div className="text-xs text-slate-400 mt-0.5">
              {apkInfo.filename} · v{apkInfo.version} · {formatBytes(apkInfo.size_bytes)} ·{' '}
              uploaded {new Date(apkInfo.uploaded_at).toLocaleDateString()}
            </div>
          </div>
          <button
            onClick={() => void onDownload()}
            disabled={downloading}
            className="touch-target px-3 py-1.5 bg-brand hover:bg-brand-dark text-white text-xs font-semibold rounded-lg flex items-center gap-1"
          >
            <Download size={12} />
            {downloading ? '…' : t('chat.download_apk')}
          </button>
        </div>
      ) : (
        <div className="bg-priority-medium/10 border border-priority-medium/30 rounded-lg p-3 mb-4 flex items-start gap-2 text-sm">
          <Info size={16} className="text-priority-medium flex-shrink-0 mt-0.5" />
          <div className="text-slate-300 text-xs leading-relaxed">
            {t('chat.no_apk_yet')}{' '}
            <a
              href={OFFICIAL_LINKS.androidReleases}
              target="_blank"
              rel="noopener noreferrer"
              className="text-brand underline"
            >
              {t('chat.download_from_github')} <ExternalLink size={10} className="inline" />
            </a>
          </div>
        </div>
      )}

      <div className="space-y-3">
        <Step
          n={1}
          icon={<Download size={18} />}
          title={t('chat.android.step1_title')}
          body={
            <>
              {t('chat.android.step1_body')}{' '}
              {apkInfo ? (
                <button onClick={() => void onDownload()} className="text-brand underline">
                  {t('chat.tap_to_download')}
                </button>
              ) : (
                <a
                  href={OFFICIAL_LINKS.androidReleases}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-brand underline inline-flex items-center gap-1"
                >
                  GitHub releases <ExternalLink size={11} />
                </a>
              )}
            </>
          }
          phone={<PhoneApk />}
        />
        <Step
          n={2}
          icon={<Cog size={18} />}
          title={t('chat.android.step2_title')}
          body={t('chat.android.step2_body')}
          phone={<PhoneSettings label="Install unknown apps" toggle />}
        />
        <Step
          n={3}
          icon={<ShieldCheck size={18} />}
          title={t('chat.android.step3_title')}
          body={t('chat.android.step3_body')}
          phone={<PhoneInstallPrompt />}
        />
        <Step
          n={4}
          icon={<Bluetooth size={18} />}
          title={t('chat.android.step4_title')}
          body={t('chat.android.step4_body')}
          phone={<PhonePermission label="Allow Bluetooth" />}
        />
        <Step
          n={5}
          icon={<MessageSquare size={18} />}
          title={t('chat.android.step5_title')}
          body={t('chat.android.step5_body')}
          phone={<PhoneNickname />}
        />
        <Step
          n={6}
          icon={<Hash size={18} />}
          title={t('chat.android.step6_title')}
          body={t('chat.android.step6_body')}
          phone={<PhoneChannels />}
        />
      </div>
    </Card>
  );
}

// =========================================================================
// Step row + phone mockup illustrations
// =========================================================================

function Step({
  n,
  icon,
  title,
  body,
  phone,
}: {
  n: number;
  icon: React.ReactNode;
  title: string;
  body: React.ReactNode;
  phone: React.ReactNode;
}) {
  return (
    <div className="grid sm:grid-cols-[100px_1fr] gap-4 items-start py-3 border-b border-slate-700 last:border-b-0">
      <div className="flex flex-col items-center gap-2">
        {phone}
        <div className="text-xs text-slate-500 font-mono">step {n}</div>
      </div>
      <div className="flex items-start gap-3">
        <div className="w-8 h-8 rounded-full bg-brand/20 text-brand flex items-center justify-center flex-shrink-0 font-bold">
          {n}
        </div>
        <div className="flex-1">
          <h3 className="font-semibold text-slate-100 flex items-center gap-2 mb-1">
            <span className="text-ai">{icon}</span>
            {title}
          </h3>
          <p className="text-sm text-slate-300 leading-relaxed">{body}</p>
        </div>
      </div>
    </div>
  );
}

// ---- Phone mockups (inline SVG, ~85x150) -------------------------------

function PhoneFrame({ children }: { children: React.ReactNode }) {
  return (
    <svg viewBox="0 0 85 150" xmlns="http://www.w3.org/2000/svg" className="w-20 h-36">
      <rect
        x="2"
        y="2"
        width="81"
        height="146"
        rx="10"
        fill="#1e293b"
        stroke="#475569"
        strokeWidth="1.5"
      />
      <rect x="6" y="10" width="73" height="125" rx="3" fill="#0f172a" />
      <circle cx="42.5" cy="142" r="3" fill="#475569" />
      <rect x="35" y="5" width="15" height="2" rx="1" fill="#475569" />
      {children}
    </svg>
  );
}

function PhoneApk() {
  return (
    <PhoneFrame>
      <text x="42" y="40" fontSize="6" fill="#8b5cf6" textAnchor="middle" fontWeight="bold">
        Downloads
      </text>
      <rect x="12" y="48" width="61" height="22" rx="3" fill="#1e293b" stroke="#475569" />
      <text x="18" y="58" fontSize="5" fill="#22c55e">
        ▼ APK
      </text>
      <text x="18" y="65" fontSize="4" fill="#94a3b8">
        bitchat.apk
      </text>
      <rect x="12" y="74" width="61" height="22" rx="3" fill="#1e293b" stroke="#334155" />
    </PhoneFrame>
  );
}

function PhoneSettings({ label, toggle }: { label: string; toggle?: boolean }) {
  return (
    <PhoneFrame>
      <text x="42" y="22" fontSize="5" fill="#94a3b8" textAnchor="middle">
        Settings
      </text>
      <rect x="12" y="32" width="61" height="14" rx="2" fill="#1e293b" />
      <text x="16" y="41" fontSize="4" fill="#cbd5e1">
        {label}
      </text>
      {toggle && (
        <>
          <rect x="56" y="36" width="14" height="6" rx="3" fill="#22c55e" />
          <circle cx="66" cy="39" r="2.5" fill="#fff" />
        </>
      )}
      <rect x="12" y="50" width="61" height="14" rx="2" fill="#1e293b" />
      <rect x="12" y="68" width="61" height="14" rx="2" fill="#1e293b" />
    </PhoneFrame>
  );
}

function PhoneInstallPrompt() {
  return (
    <PhoneFrame>
      <rect x="10" y="40" width="65" height="60" rx="4" fill="#1e293b" stroke="#475569" />
      <text x="42" y="55" fontSize="5" fill="#cbd5e1" textAnchor="middle" fontWeight="bold">
        Install bitchat?
      </text>
      <rect x="16" y="78" width="22" height="10" rx="2" fill="#334155" />
      <text x="27" y="85" fontSize="4" fill="#cbd5e1" textAnchor="middle">
        Cancel
      </text>
      <rect x="46" y="78" width="22" height="10" rx="2" fill="#0ea5e9" />
      <text x="57" y="85" fontSize="4" fill="#fff" textAnchor="middle">
        Install
      </text>
    </PhoneFrame>
  );
}

function PhonePermission({ label }: { label: string }) {
  return (
    <PhoneFrame>
      <rect x="10" y="38" width="65" height="65" rx="4" fill="#1e293b" stroke="#475569" />
      <circle cx="42" cy="55" r="6" fill="#0ea5e9" />
      <text x="42" y="58" fontSize="6" fill="#fff" textAnchor="middle">
        ⌬
      </text>
      <text x="42" y="72" fontSize="4" fill="#cbd5e1" textAnchor="middle">
        {label}?
      </text>
      <rect x="16" y="83" width="22" height="10" rx="2" fill="#334155" />
      <text x="27" y="90" fontSize="4" fill="#cbd5e1" textAnchor="middle">
        Deny
      </text>
      <rect x="46" y="83" width="22" height="10" rx="2" fill="#22c55e" />
      <text x="57" y="90" fontSize="4" fill="#fff" textAnchor="middle">
        Allow
      </text>
    </PhoneFrame>
  );
}

function PhoneNickname() {
  return (
    <PhoneFrame>
      <text x="42" y="22" fontSize="5" fill="#cbd5e1" textAnchor="middle" fontWeight="bold">
        bitchat
      </text>
      <text x="42" y="42" fontSize="4" fill="#94a3b8" textAnchor="middle">
        Nickname
      </text>
      <rect x="14" y="46" width="57" height="12" rx="2" fill="#1e293b" stroke="#475569" />
      <text x="18" y="54" fontSize="4" fill="#22c55e">
        FW-Pierre
      </text>
      <rect x="22" y="68" width="41" height="12" rx="3" fill="#0ea5e9" />
      <text x="42" y="76" fontSize="4" fill="#fff" textAnchor="middle">
        Continue
      </text>
    </PhoneFrame>
  );
}

function PhoneChannels() {
  return (
    <PhoneFrame>
      <text x="42" y="20" fontSize="4" fill="#cbd5e1" textAnchor="middle" fontWeight="bold">
        Channels
      </text>
      <rect x="12" y="26" width="61" height="10" rx="1" fill="#0ea5e9" opacity="0.25" />
      <text x="16" y="33" fontSize="4" fill="#0ea5e9">
        # sector-b-north
      </text>
      <rect x="12" y="38" width="61" height="10" rx="1" fill="#1e293b" />
      <text x="16" y="45" fontSize="4" fill="#cbd5e1">
        # medical-team
      </text>
      <rect x="12" y="50" width="61" height="10" rx="1" fill="#1e293b" />
      <text x="16" y="57" fontSize="4" fill="#cbd5e1">
        # logistics
      </text>
      <rect x="12" y="62" width="61" height="10" rx="1" fill="#1e293b" />
      <text x="16" y="69" fontSize="4" fill="#cbd5e1">
        # general
      </text>
      <rect x="22" y="98" width="41" height="12" rx="6" fill="#22c55e" />
      <text x="42" y="106" fontSize="4" fill="#fff" textAnchor="middle">
        + new
      </text>
    </PhoneFrame>
  );
}
