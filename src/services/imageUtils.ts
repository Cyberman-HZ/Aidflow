// Browser-side image utilities for the paper-form ingest pipeline.
//
// Why this exists:
//
//   1. Mobile photos from field workers are typically 3-12 MP — that's
//      multiple megabytes of base64 to ship into Ollama's chat endpoint
//      every request. Vision inference on a CPU-only laptop is already
//      slow; sending a giant base64 string makes the first-token latency
//      visibly worse. We resize the longest edge to 1024 px (a sane
//      default for vision-language models — most can't actually resolve
//      finer detail) and re-encode as JPEG q=0.85 before transport.
//
//   2. Ollama's chat API expects RAW base64 in the `images: []` array,
//      NOT the `data:image/jpeg;base64,…` form a browser FileReader
//      gives you. The strip is a one-liner but is easy to forget; this
//      utility hides the foot-gun.
//
// Everything here is intentionally framework-free and runs entirely in
// the browser. No network. No bundle size beyond a Canvas2D context.

/** Hard caps so a misbehaving caller can't OOM the tab. */
const MAX_INPUT_BYTES = 25 * 1024 * 1024; // 25 MB
const DEFAULT_MAX_DIM = 1024;
const DEFAULT_JPEG_QUALITY = 0.85;

export interface ResizedImage {
  /** Raw base64 (no `data:image/jpeg;base64,` prefix). What Ollama wants. */
  base64: string;
  /** Same content but prefixed — convenient for <img src=…> previews. */
  dataUrl: string;
  /** Width × height AFTER resize, in CSS pixels. */
  width: number;
  height: number;
  /** Approximate byte size of the encoded JPEG. */
  bytes: number;
  /** MIME of the encoded output (always image/jpeg today). */
  mime: 'image/jpeg';
}

/**
 * Read a `File` (from <input type=file> / drop / camera capture) into a
 * resized JPEG suitable for shipping to Ollama. Throws on:
 *   - non-image files
 *   - files over 25 MB
 *   - browsers without canvas / createImageBitmap (we fall back, but very
 *     old engines may still fail)
 */
export async function fileToResizedJpegBase64(
  file: File,
  opts: { maxDim?: number; quality?: number } = {}
): Promise<ResizedImage> {
  if (!file.type.startsWith('image/')) {
    throw new Error(`Unsupported file type: ${file.type || 'unknown'}`);
  }
  if (file.size > MAX_INPUT_BYTES) {
    const mb = Math.round((file.size / 1024 / 1024) * 10) / 10;
    throw new Error(`Image too large (${mb} MB). Max 25 MB.`);
  }

  const maxDim = Math.max(256, opts.maxDim ?? DEFAULT_MAX_DIM);
  const quality = Math.min(1, Math.max(0.5, opts.quality ?? DEFAULT_JPEG_QUALITY));

  // Decode the input → ImageBitmap (faster, off-main-thread when supported)
  // or fall back to a hidden <img> for engines without createImageBitmap.
  const bitmap = await decodeImage(file);

  // Compute the target dims preserving aspect ratio.
  const sw = bitmap.width;
  const sh = bitmap.height;
  const scale = Math.min(1, maxDim / Math.max(sw, sh));
  const dw = Math.max(1, Math.round(sw * scale));
  const dh = Math.max(1, Math.round(sh * scale));

  // Draw into an offscreen canvas and re-encode as JPEG.
  const canvas =
    typeof OffscreenCanvas !== 'undefined'
      ? (new OffscreenCanvas(dw, dh) as unknown as HTMLCanvasElement)
      : Object.assign(document.createElement('canvas'), { width: dw, height: dh });
  const ctx = (canvas as HTMLCanvasElement).getContext('2d');
  if (!ctx) throw new Error('Could not acquire 2D canvas context.');
  ctx.drawImage(bitmap, 0, 0, dw, dh);

  // toBlob preserves quality control; toDataURL would also work but
  // double-allocates. Both paths converge to base64 below.
  const blob: Blob = await new Promise((resolve, reject) => {
    const c = canvas as HTMLCanvasElement;
    if (typeof (c as any).convertToBlob === 'function') {
      (c as any).convertToBlob({ type: 'image/jpeg', quality }).then(resolve, reject);
    } else {
      c.toBlob(
        (b) => (b ? resolve(b) : reject(new Error('canvas.toBlob() returned null'))),
        'image/jpeg',
        quality
      );
    }
  });

  const dataUrl = await blobToDataUrl(blob);
  const base64 = stripDataUrlPrefix(dataUrl);

  return {
    base64,
    dataUrl,
    width: dw,
    height: dh,
    bytes: blob.size,
    mime: 'image/jpeg',
  };
}

/**
 * Best-effort decode that prefers `createImageBitmap` (handles EXIF
 * orientation and is off-main-thread on modern engines) and falls back
 * to an `<img>` element on older browsers.
 */
async function decodeImage(
  file: File
): Promise<ImageBitmap | HTMLImageElement> {
  if (typeof createImageBitmap === 'function') {
    try {
      // imageOrientation: 'from-image' applies EXIF rotation so a portrait
      // phone photo doesn't show up sideways in the canvas. Some older
      // engines reject the option object — fall through to <img> if so.
      return await createImageBitmap(file, {
        imageOrientation: 'from-image' as ImageOrientation,
      });
    } catch {
      // fall through to <img>
    }
  }
  // <img> path (works everywhere a canvas works).
  return await new Promise<HTMLImageElement>((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('Could not decode image.'));
    };
    img.src = url;
  });
}

/** Convert a Blob to a `data:` URL via FileReader. */
function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error ?? new Error('FileReader failed.'));
    r.readAsDataURL(blob);
  });
}

/** Strip the `data:image/...;base64,` prefix off a data URL. */
export function stripDataUrlPrefix(dataUrl: string): string {
  const i = dataUrl.indexOf('base64,');
  return i >= 0 ? dataUrl.slice(i + 'base64,'.length) : dataUrl;
}

/** Approximate KB of a base64 string, for showing in the UI. */
export function approxBase64Kb(b64: string): number {
  // base64 is 4 chars per 3 bytes — close enough for a "size" label.
  return Math.round((b64.length * 3) / 4 / 1024);
}
