// AidFlow Android companion-app distribution.
//
// Admin uploads the latest .apk once while online; field teams on the
// same AidFlow instance can download it offline. Singleton storage in
// IndexedDB — uploading a new build replaces the previous one.
//
// The Android app source + beta release builds live at:
//   https://github.com/Cyberman-HZ/Aidflow-android-app-powered-by-gemma-4

import { db } from '@/db/database';
import type { AidflowAndroidApk } from '@/types';

const SINGLETON_ID = 'aidflow-android';

export const AIDFLOW_ANDROID_REPO =
  'https://github.com/Cyberman-HZ/Aidflow-android-app-powered-by-gemma-4';

export interface UploadOptions {
  version: string;
  uploaded_by: string;
  notes?: string;
}

export async function uploadApk(file: File, opts: UploadOptions): Promise<AidflowAndroidApk> {
  if (file.size === 0) throw new Error('Empty file');
  // 500 MB ceiling — generous; current AidFlow Mobile APK is well below this
  // because the Gemma 4 E2B model downloads on first launch, not bundled.
  if (file.size > 500 * 1024 * 1024) {
    throw new Error('File too large (max 500 MB)');
  }
  if (!file.name.toLowerCase().endsWith('.apk')) {
    throw new Error('Please choose a .apk file.');
  }
  const record: AidflowAndroidApk = {
    id: SINGLETON_ID,
    filename: file.name,
    version: opts.version.trim() || 'unknown',
    size_bytes: file.size,
    mime: file.type || 'application/vnd.android.package-archive',
    uploaded_at: new Date().toISOString(),
    uploaded_by: opts.uploaded_by,
    notes: opts.notes,
    data: file,
  };
  await db.aidflowAndroidApks.put(record);
  return record;
}

/**
 * Returns the APK metadata (without the Blob) so live-query subscribers
 * don't pull tens of megabytes into the React tree on every render.
 */
export async function getApkInfo(): Promise<Omit<AidflowAndroidApk, 'data'> | null> {
  const row = await db.aidflowAndroidApks.get(SINGLETON_ID);
  if (!row) return null;
  const { data: _data, ...meta } = row;
  return meta;
}

export async function downloadApk(): Promise<void> {
  const row = await db.aidflowAndroidApks.get(SINGLETON_ID);
  if (!row) {
    throw new Error('No APK uploaded yet — ask your administrator to upload it.');
  }
  const url = URL.createObjectURL(row.data);
  const a = document.createElement('a');
  a.href = url;
  a.download = row.filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoke after a short delay so the browser has time to start the download.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export async function deleteApk(): Promise<void> {
  await db.aidflowAndroidApks.delete(SINGLETON_ID);
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
