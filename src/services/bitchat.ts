// AidFlow Pro — Bitchat companion-app distribution.
//
// We do NOT implement Bitchat in the browser (Web Bluetooth's Central-only
// role makes that fundamentally impossible — see the documented limitations
// in the project README). Instead, AidFlow Pro hosts the official native
// Bitchat installers so field teams can install the real apps offline.
//
// Admins upload the latest .apk (Android) once while online. The file is
// stored as a Blob in IndexedDB on the org's AidFlow instance and any team
// member connected to that instance — even fully offline — can download it
// and sideload it onto their phone.
//
// iOS distribution requires Apple's TestFlight or an enterprise certificate;
// we cannot host the IPA directly, so the iOS section just records the
// public TestFlight invite URL for offline reference.

import { db } from '@/db/database';
import type { BitchatApk } from '@/types';

export const OFFICIAL_LINKS = {
  repo: 'https://github.com/permissionlesstech/bitchat',
  whitepaper: 'https://github.com/permissionlesstech/bitchat/blob/main/WHITEPAPER.md',
  androidRepo: 'https://github.com/permissionlesstech/bitchat-android',
  androidReleases: 'https://github.com/permissionlesstech/bitchat-android/releases/latest',
  androidPlayStore: 'https://play.google.com/store/apps/details?id=com.bitchat.android',
  bitchatHomepage: 'https://bitchat.free',
};

// ---------------------------------------------------------------------
// Admin upload
// ---------------------------------------------------------------------

export interface UploadOptions {
  app: BitchatApk['app'];
  version: string;
  uploaded_by: string;
  notes?: string;
  release_url?: string;
}

export async function uploadApk(file: File, opts: UploadOptions): Promise<BitchatApk> {
  if (file.size === 0) throw new Error('Empty file');
  if (file.size > 200 * 1024 * 1024) {
    throw new Error('File too large (max 200 MB) — Bitchat APKs are typically 5–20 MB');
  }
  const record: BitchatApk = {
    id: opts.app, // singleton per app — replaces previous version
    app: opts.app,
    filename: file.name,
    version: opts.version.trim() || 'unknown',
    size_bytes: file.size,
    mime: file.type || 'application/vnd.android.package-archive',
    uploaded_at: new Date().toISOString(),
    uploaded_by: opts.uploaded_by,
    notes: opts.notes,
    data: file,
    release_url: opts.release_url,
  };
  await db.bitchatApks.put(record);
  return record;
}

// ---------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------

export async function getApkInfo(app: BitchatApk['app']): Promise<Omit<BitchatApk, 'data'> | null> {
  const row = await db.bitchatApks.get(app);
  if (!row) return null;
  // Strip the blob from the returned info — callers asking for metadata
  // only shouldn't pull tens of megabytes into memory.
  const { data: _data, ...meta } = row;
  return meta;
}

export async function downloadApk(app: BitchatApk['app']): Promise<void> {
  const row = await db.bitchatApks.get(app);
  if (!row) throw new Error('No APK uploaded yet — ask your administrator to upload it.');
  const url = URL.createObjectURL(row.data);
  const a = document.createElement('a');
  a.href = url;
  a.download = row.filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoke after a short delay so the download has time to start
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export async function deleteApk(app: BitchatApk['app']): Promise<void> {
  await db.bitchatApks.delete(app);
}

// ---------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
