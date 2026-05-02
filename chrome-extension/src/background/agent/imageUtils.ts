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

/**
 * T2f-coords — coordinate-grid overlay for click-grounding.
 *
 * Set-of-Mark / grid prompting is the current best-practice when a
 * general-purpose VLM (Sonnet 4.x, Gemini 2.5, GPT-4o) needs to
 * report click coordinates on a screenshot. Without explicit visual
 * anchors raw-coordinate accuracy collapses below 60% on dense UI.
 * Drawing a labelled 10×10 grid lifts it to ~75-85% on common
 * benchmarks (WebVoyager / SeeAct / VisualWebArena).
 *
 * Layout: 10 columns × 10 rows over the source image. Each cell
 * shows its centre image-pixel coordinate, e.g. `(64,40)` in the
 * upper-left of the cell, plus a thin axis-aligned cross at the
 * cell centre. Lines are semi-transparent so the underlying UI
 * stays readable.
 *
 * The image returned is JPEG q=0.85 (close to lossless for the line
 * overlay; the source already came in as JPEG q=0.8) so accuracy
 * does not regress. Always uses image-pixel coordinates — DPR
 * conversion happens at click_at execution time.
 */
export async function applyCoordinateGrid(
  base64: string,
  mime = 'image/jpeg',
  cols = 10,
  rows = 10,
): Promise<{ base64: string; mime: string; width: number; height: number } | null> {
  try {
    const blob = base64ToBlob(base64, mime);
    const bmp = await createImageBitmap(blob);
    const W = bmp.width;
    const H = bmp.height;
    const canvas = new OffscreenCanvas(W, H);
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      bmp.close?.();
      return null;
    }
    ctx.drawImage(bmp, 0, 0);
    bmp.close?.();
    const cellW = W / cols;
    const cellH = H / rows;
    // Grid lines.
    ctx.strokeStyle = 'rgba(255,255,255,0.55)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let i = 1; i < cols; i++) {
      const x = Math.round(i * cellW) + 0.5;
      ctx.moveTo(x, 0);
      ctx.lineTo(x, H);
    }
    for (let j = 1; j < rows; j++) {
      const y = Math.round(j * cellH) + 0.5;
      ctx.moveTo(0, y);
      ctx.lineTo(W, y);
    }
    ctx.stroke();
    // Per-cell centre marker + label.
    ctx.font = '10px ui-monospace, Menlo, monospace';
    ctx.textBaseline = 'top';
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const cx = Math.round((c + 0.5) * cellW);
        const cy = Math.round((r + 0.5) * cellH);
        // Cross at centre.
        ctx.strokeStyle = 'rgba(255,255,255,0.7)';
        ctx.beginPath();
        ctx.moveTo(cx - 3, cy);
        ctx.lineTo(cx + 3, cy);
        ctx.moveTo(cx, cy - 3);
        ctx.lineTo(cx, cy + 3);
        ctx.stroke();
        // Label with centre coords in upper-left of cell.
        const label = `(${cx},${cy})`;
        const px = Math.round(c * cellW) + 3;
        const py = Math.round(r * cellH) + 2;
        // Tight backdrop for legibility on bright cells.
        const w = ctx.measureText(label).width + 4;
        ctx.fillStyle = 'rgba(0,0,0,0.55)';
        ctx.fillRect(px - 1, py - 1, w, 12);
        ctx.fillStyle = 'rgba(255,255,255,0.95)';
        ctx.fillText(label, px + 1, py);
      }
    }
    const outBlob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.85 });
    const out64 = await blobToBase64(outBlob);
    return { base64: out64, mime: 'image/jpeg', width: W, height: H };
  } catch (err) {
    logger.warning('applyCoordinateGrid failed', err);
    return null;
  }
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
