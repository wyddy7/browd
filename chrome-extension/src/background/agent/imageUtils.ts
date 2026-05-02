/**
 * T2f-1.5b — image helpers used by the trace pipeline.
 *
 * `downscaleJpegToThumb` shrinks a base64 JPEG (the puppeteer viewport
 * capture) into a small thumbnail suitable for shipping inline with a
 * STEP_TRACE event. We use OffscreenCanvas because the MV3 service
 * worker has no DOM and `Image`/`<canvas>` are unavailable; OffscreenCanvas
 * + createImageBitmap is the documented Chrome path.
 *
 * Default target ~256×144 / quality 0.6 → ~5–10 KB. Cheap enough that
 * shipping every step over chrome.runtime port is fine; heavy enough
 * that the side-panel preview is still legible.
 */
import { createLogger } from '@src/background/log';

const logger = createLogger('imageUtils');

export interface ThumbResult {
  base64: string;
  mime: string;
  width: number;
  height: number;
}

function base64ToBlob(b64: string, mime: string): Blob {
  const bin = atob(b64);
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  return new Blob([buf], { type: mime });
}

async function blobToBase64(blob: Blob): Promise<string> {
  const ab = await blob.arrayBuffer();
  const u8 = new Uint8Array(ab);
  // JPEGs are large enough that String.fromCharCode.apply blows the
  // call-stack limit on some Chromium builds; chunk to be safe.
  let s = '';
  const chunk = 0x8000;
  for (let i = 0; i < u8.length; i += chunk) {
    s += String.fromCharCode.apply(null, Array.from(u8.subarray(i, i + chunk)) as number[]);
  }
  return btoa(s);
}

export async function downscaleJpegToThumb(
  base64: string,
  sourceMime = 'image/jpeg',
  maxWidth = 256,
  maxHeight = 144,
  quality = 0.6,
): Promise<ThumbResult | null> {
  try {
    const blob = base64ToBlob(base64, sourceMime);
    const bitmap = await createImageBitmap(blob);
    const ratio = Math.min(maxWidth / bitmap.width, maxHeight / bitmap.height, 1);
    const w = Math.max(1, Math.round(bitmap.width * ratio));
    const h = Math.max(1, Math.round(bitmap.height * ratio));
    const canvas = new OffscreenCanvas(w, h);
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      logger.warning('OffscreenCanvas 2d context unavailable — skipping thumbnail');
      bitmap.close?.();
      return null;
    }
    ctx.drawImage(bitmap, 0, 0, w, h);
    bitmap.close?.();
    const outBlob = await canvas.convertToBlob({ type: 'image/jpeg', quality });
    const out64 = await blobToBase64(outBlob);
    return { base64: out64, mime: 'image/jpeg', width: w, height: h };
  } catch (err) {
    logger.warning('downscaleJpegToThumb failed', err);
    return null;
  }
}
