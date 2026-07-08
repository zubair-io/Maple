/**
 * Flattened-raster decode for Photoshop PSD/PSB and Radiance HDR — the two
 * new M2 formats (#1834, part of the file-type-coverage epic #1831).
 *
 * Both formats decode to a plain RGBA8 raster in memory; the caller (in
 * `render.ts`) feeds that raster into `sharp` via its `raw` input mode,
 * reusing the exact same resize/JPEG-encode path as every other bitmap
 * format. No layer-aware editing, no color management beyond a literal
 * channel copy for PSD and a simple tone-map for HDR — this is a
 * library-browsing thumbnail, not the scene-linear RAW pipeline documented
 * in docs/architecture.md.
 *
 * PSD decode runs in-process inside the persistent `imgdecode.child.ts`
 * (same as every other bitmap format). HDR decode does NOT — see this
 * file's `decodeHdrToneMapped` doc and `hdr-decode.child.ts` for why it
 * needs its own one-shot child process per call instead.
 *
 * PSD/PSB: via `ag-psd`, reading only the merged/composite image
 * (`useImageData: true`, `skipLayerImageData: true` — full layer-aware access
 * is out of scope per the epic). `ag-psd`'s composite-image read path calls
 * back into a `createImageData` factory that, unconfigured, throws expecting
 * a DOM `<canvas>`. `initializeCanvasFreeMode()` below installs a plain
 * `{ width, height, data: Uint8ClampedArray }` factory instead — verified
 * empirically that `createCanvas` itself is never invoked on this read path
 * (it only fires for canvas-object output or layer thumbnails, both skipped
 * here), so no native `canvas` package is required in this Bun backend.
 *
 * Radiance HDR: via the `hdr` package, a small streaming reader of the
 * classic Radiance/`.pic` RGBE format. It always emits CIE XYZ float triples
 * (`Float32Array`, non-planar `[X,Y,Z,X,Y,Z,...]`) regardless of the source
 * file's own encoding — the library's stated one-line contract, confirmed by
 * reading its README/source rather than assumed. We convert XYZ (D65) to
 * linear sRGB via the standard CIE matrix, then Reinhard-tonemap
 * (`x / (1 + x)`) before an sRGB OETF gamma and 8-bit quantization. HDR scene
 * values routinely exceed 1.0; a plain clamp would blow every bright region
 * to flat white, so Reinhard is the minimum viable tonemap for a browsable
 * thumbnail (not a substitute for the AgX view transform used by the real
 * RAW pipeline).
 *
 * `hdr`'s decode loop is entirely synchronous with no `await` points, and —
 * verified empirically — spins forever on input with no recognizable
 * Radiance header/dimension line rather than erroring out. `decodeHdrToneMapped`
 * therefore validates the header itself before ever calling into the library
 * (see `looksLikeRadianceHdr`); a `setTimeout` race could not have worked
 * here since a synchronous infinite loop never yields the thread for the
 * timer callback to run.
 */

import { readPsd, initializeCanvas } from 'ag-psd';
// `hdr` ships no type declarations; its default export is a CJS object
// `{ loader, utils }` per README/source (`lib/hdr.js`).
// eslint-disable-next-line @typescript-eslint/no-var-requires
import HDR from 'hdr';
import { Readable } from 'node:stream';

/** A plain, un-encoded RGBA8 raster — sharp's `raw` input shape. */
export interface DecodedRaster {
  width: number;
  height: number;
  /** Interleaved RGBA, 4 bytes/pixel, row-major, no padding. */
  data: Uint8Array;
}

let canvasFreeModeInstalled = false;

/**
 * Install a canvas-free `createImageData` factory once per process. Safe to
 * call repeatedly — only the first call takes effect. `createCanvas` is
 * still wired to a throwing stub: if a future `ag-psd` version (or a read
 * option change) exercises a canvas-producing path, we want a loud failure
 * here, not a silent wrong-shape return.
 */
function initializeCanvasFreeMode(): void {
  if (canvasFreeModeInstalled) return;
  initializeCanvas(
    () => {
      throw new Error(
        'psd-hdr-decode: createCanvas invoked — composite-only decode should never need it',
      );
    },
    (width: number, height: number) =>
      ({
        width,
        height,
        data: new Uint8ClampedArray(width * height * 4),
      }) as unknown as ImageData,
  );
  canvasFreeModeInstalled = true;
}

/**
 * Decode a PSD or PSB buffer to its flattened composite raster (the
 * merged/preview image Photoshop shows by default — not a layer-aware
 * render). Throws on decode failure; callers treat that as a normal decode
 * failure, same as a corrupt JPEG reaching sharp.
 */
export function decodePsdComposite(buf: Uint8Array): DecodedRaster {
  initializeCanvasFreeMode();
  const psd = readPsd(buf, {
    skipLayerImageData: true,
    useImageData: true,
    skipThumbnail: true,
    skipLinkedFilesData: true,
  });
  if (!psd.imageData) {
    throw new Error('psd-hdr-decode: no composite image data in PSD/PSB (empty or layer-only doc)');
  }
  const { width, height, data } = psd.imageData;
  return { width, height, data: normalizeToRgba8(data, width, height) };
}

/**
 * `ag-psd`'s `PixelData.data` is 8-bit for the common case we request
 * (composite-only, `useImageData: true`, RGB/CMYK-normalized-to-4-channel
 * color modes) but the type is technically `Uint8ClampedArray | Uint8Array |
 * Uint16Array | Float32Array` to cover 16/32-bit-per-channel documents.
 * Convert defensively so a HDR-bit-depth PSD (uncommon but valid) doesn't
 * silently misinterpret 16-bit samples as 8-bit bytes.
 */
function normalizeToRgba8(
  data: Uint8ClampedArray | Uint8Array | Uint16Array | Float32Array,
  width: number,
  height: number,
): Uint8Array {
  const pixels = width * height;
  if (data instanceof Uint8ClampedArray || data instanceof Uint8Array) {
    return new Uint8Array(data.buffer, data.byteOffset, pixels * 4);
  }
  const out = new Uint8Array(pixels * 4);
  if (data instanceof Uint16Array) {
    for (let i = 0; i < pixels * 4; i++) out[i] = data[i]! >>> 8;
    return out;
  }
  // Float32Array: ag-psd stores these as normalized [0, 1] linear samples
  // (per its own imageDataToCanvas conversion, which applies a 1/2.2 gamma
  // before scaling to 8-bit) — mirror that here for consistency.
  for (let i = 0; i < pixels; i++) {
    const base = i * 4;
    out[base + 0] = Math.round(Math.pow(clamp01(data[base + 0]!), 1 / 2.2) * 255);
    out[base + 1] = Math.round(Math.pow(clamp01(data[base + 1]!), 1 / 2.2) * 255);
    out[base + 2] = Math.round(Math.pow(clamp01(data[base + 2]!), 1 / 2.2) * 255);
    out[base + 3] = Math.round(clamp01(data[base + 3]!) * 255);
  }
  return out;
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** CIE XYZ (D65) → linear sRGB, standard 3x3 matrix (IEC 61966-2-1). */
const XYZ_TO_LINEAR_SRGB = [
  3.2404542, -1.5371385, -0.4985314, -0.969266, 1.8760108, 0.041556, 0.0556434, -0.2040259,
  1.0572252,
] as const;

/** sRGB OETF (gamma) for an already-tonemapped-to-[0,1] linear channel. */
function srgbOetf(c: number): number {
  const v = c <= 0 ? 0 : c >= 1 ? 1 : c;
  return v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
}

/** Reinhard tonemap: compresses unbounded scene-linear values into [0, 1)
 * without a hard clip. `x / (1 + x)`. Applied per-channel — simple, cheap,
 * and sufficient for a browsing thumbnail (see module doc for why this
 * isn't the AgX view transform). */
function reinhard(x: number): number {
  return x <= 0 ? 0 : x / (1 + x);
}

/**
 * `hdr`'s loader parses the Radiance header and dimension line lazily as
 * bytes stream in; when neither is ever found (truncated input, or a file
 * that isn't actually Radiance/RGBE despite its extension) its `width`/
 * `height` stay at their `-1` sentinel and its internal scanline-decode loop
 * — entirely synchronous, no `await` points — spins on a buffer it never
 * advances. Verified empirically: this is a true synchronous infinite loop,
 * not a slow-but-eventually-settling decode, so no `setTimeout`/Promise race
 * from the outside can ever preempt it (the timer callback never gets a
 * turn on the event loop). The only correct guard is to validate the
 * Radiance magic + dimension line ourselves, synchronously, before ever
 * handing bytes to the library. A file that passes this check but is
 * otherwise malformed deeper in (truncated scanline data, etc.) is not
 * covered — that's a genuine gap in the `hdr` package with no clean
 * workaround short of forking it; out of scope for this ticket, called out
 * here for visibility.
 *
 * Separately, and much more severely: `hdr` cannot safely decode more than
 * ONE file per process lifetime. Empirically confirmed (not a concurrency
 * artifact — reproduced with two decodes run strictly sequentially, no
 * overlap): a second `decodeHdrToneMapped` call in the same process hangs
 * forever, specifically when the file has real RLE-compressed multi-scanline
 * data (a trivial 1x1 synthetic buffer can be decoded repeatedly without
 * issue, which is why this didn't surface until a real committed fixture was
 * exercised twice). A `globalThis`-keyed serializing queue was tried first
 * and did NOT help — the corruption isn't from two decodes racing each
 * other, it survives even with the second call starting well after the
 * first fully resolved. Whatever module-level state `hdr` mutates during a
 * real multi-scanline decode, it never resets it, and a second call the
 * library was never written to expect walks straight into the wreckage.
 *
 * There is no clean in-process fix short of forking the library. Given
 * `imgdecode-pool.ts` runs ONE persistent child for every thumbnail request
 * for the process's entire lifetime, calling this function from inside that
 * child would hang the SECOND HDR file Maple ever tries to thumbnail — and
 * likely every request queued behind it in that same child. Callers MUST
 * NOT call `decodeHdrToneMapped` from the persistent imgdecode child; use
 * the one-shot, spawn-per-call isolation in `hdr-decode.child.ts` /
 * `decodeHdrIsolated` (in `hdr-decode-isolated.ts`) instead, which guarantees
 * every process instance decodes exactly once before exiting. This function
 * itself remains exported (and independently unit-tested) because that
 * isolated child needs something to call — just never call it more than
 * once per process outside of that isolation boundary.
 */
const RADIANCE_HEADER_RE = /^#\?(RADIANCE|RGBE)\r?\n/;
const RADIANCE_DIMENSION_RE = /[+-][XY]\s+\d+\s+[+-][XY]\s+\d+/;

function looksLikeRadianceHdr(buf: Uint8Array): boolean {
  // The header + dimension line are always ASCII and always appear within
  // the first ~1 KiB even for files with many comment lines; 4 KiB is a
  // generous bound that stays cheap for the synchronous pre-check.
  const head = Buffer.from(buf.subarray(0, Math.min(buf.length, 4096))).toString('latin1');
  return RADIANCE_HEADER_RE.test(head) && RADIANCE_DIMENSION_RE.test(head);
}

/**
 * Decode a Radiance HDR (`.hdr` / `.pic`) buffer to a tone-mapped RGBA8
 * raster. `hdr`'s loader is a Writable stream; we feed it the whole buffer
 * (thumbnailing is not a streaming/incremental use case) and await its
 * `load`/`error` events. Rejects immediately, before touching the library,
 * for input that doesn't even look like Radiance HDR — see
 * `looksLikeRadianceHdr` for why that pre-check exists.
 *
 * CALL AT MOST ONCE PER PROCESS — see the module doc above `RADIANCE_HEADER_RE`
 * for why. Production code must go through the per-call process isolation in
 * `hdr-decode-isolated.ts`, never straight through this export.
 */
export async function decodeHdrToneMapped(buf: Uint8Array): Promise<DecodedRaster> {
  if (!looksLikeRadianceHdr(buf)) {
    throw new Error(
      'psd-hdr-decode: not a recognizable Radiance HDR file (missing header/dimension line)',
    );
  }
  const loader = new HDR.loader();

  const result = await new Promise<{ width: number; height: number; data: Float32Array }>(
    (resolve, reject) => {
      loader.on('load', function (this: { width: number; height: number; data: Float32Array }) {
        resolve({ width: this.width, height: this.height, data: this.data });
      });
      loader.on('error', (err: unknown) => {
        reject(err instanceof Error ? err : new Error(String(err) || 'hdr decode error'));
      });
      Readable.from(Buffer.from(buf)).pipe(loader);
    },
  );

  const { width, height, data } = result;
  if (width <= 0 || height <= 0 || data.length !== width * height * 3) {
    throw new Error(
      `psd-hdr-decode: malformed HDR decode result (${width}x${height}, ${data.length} samples)`,
    );
  }

  const pixels = width * height;
  const out = new Uint8Array(pixels * 4);
  const [m00, m01, m02, m10, m11, m12, m20, m21, m22] = XYZ_TO_LINEAR_SRGB;
  for (let i = 0; i < pixels; i++) {
    const x = data[i * 3 + 0]!;
    const y = data[i * 3 + 1]!;
    const z = data[i * 3 + 2]!;
    const r = m00 * x + m01 * y + m02 * z;
    const g = m10 * x + m11 * y + m12 * z;
    const b = m20 * x + m21 * y + m22 * z;

    const base = i * 4;
    out[base + 0] = Math.round(srgbOetf(reinhard(r)) * 255);
    out[base + 1] = Math.round(srgbOetf(reinhard(g)) * 255);
    out[base + 2] = Math.round(srgbOetf(reinhard(b)) * 255);
    out[base + 3] = 255; // Radiance HDR carries no alpha channel.
  }
  return { width, height, data: out };
}
