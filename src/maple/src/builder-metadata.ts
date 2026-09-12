/**
 * `metadata()`, `stats()`, and the metadata-passthrough builder methods
 * (`keepMetadata`, `withMetadata`, `withExif`, `withIccProfile`, `withXmp`) —
 * split out of `builder.ts` to keep that file inside the repo's file-size
 * budget as Tier 2 adds op methods (#3505, #3507). Every function here takes
 * the `BuilderState`; `builder.ts`'s class methods are thin wrappers that
 * call into these and (for the fluent setters) `return this`.
 *
 * Backed by `maple_raster_analyze_buf` (`native-raster-analyze.ts`) — see
 * `raw-pipeline/raw-core/src/raster_analyze.rs` for the JSON reply this
 * mirrors field-for-field, and `raster_recipe_meta.rs::RecipeMetadata` for
 * the recipe `metadata` block the `with*`/`keep*` methods populate.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { isRawDevelop, rawDevelopToBuffer, rawDevelopToFile } from './builder-raw-develop';
import { isRawPath, type BuilderState } from './builder-state';
import { loadNativeBinding } from './native';
import type { ChannelStats, ImageMetadata, ImageStats, RawPixelInput } from './types';

/** Run one `{v:1,what:[...]}` analyze request against `bytes`. */
async function analyzeBytes(
  bytes: Uint8Array,
  what: ('metadata' | 'stats')[],
): Promise<Record<string, unknown>> {
  const native = loadNativeBinding();
  const res = native.rasterAnalyzeBuf(bytes, JSON.stringify({ v: 1, what }));
  if (!res.ok || !res.json) {
    throw new Error(res.error || 'Failed to analyze image');
  }
  return JSON.parse(res.json) as Record<string, unknown>;
}

/** Decode a base64 field from an analyze reply, or `undefined` when absent (JSON `null`). */
function decodeBlock(value: unknown): Buffer | undefined {
  return typeof value === 'string' ? Buffer.from(value, 'base64') : undefined;
}

/** `analyze()`'s `metadata` reply, mapped onto the public `ImageMetadata` shape. */
function metadataFromReply(reply: Record<string, unknown>): ImageMetadata {
  const m = reply.metadata as Record<string, unknown>;
  return {
    width: m.width as number,
    height: m.height as number,
    format: m.format as string,
    channels: m.channels as number,
    orientation: m.orientation as number,
    // Reaching this branch already ruled out a camera RAW file (routed to
    // `tier1PathMetadata`/`tier1BufMetadata` instead) — always `false` here.
    isRaw: false,
    hasAlpha: m.hasAlpha as boolean,
    hasProfile: m.hasProfile as boolean,
    space: m.space as string,
    depth: m.depth as string,
    density: (m.density as number | null) ?? undefined,
    size: m.size as number,
    icc: decodeBlock(m.icc),
    exif: decodeBlock(m.exif),
    xmp: decodeBlock(m.xmp),
  };
}

/** `analyze()`'s `stats` reply — its field names already match `ImageStats` 1:1. */
function statsFromReply(reply: Record<string, unknown>): ImageStats {
  const s = reply.stats as {
    channels: ChannelStats[];
    isOpaque: boolean;
    entropy: number;
    sharpness: number;
    dominant: { r: number; g: number; b: number };
  };
  return s;
}

/** The header-only probe Tier 1 used for any file path, unchanged for a RAW file. */
async function tier1PathMetadata(inputPath: string): Promise<ImageMetadata> {
  const native = loadNativeBinding();
  const res = native.rasterProbeMetadata(inputPath);
  if (!res.ok || !res.metadata) {
    throw new Error(res.error || `Failed to probe metadata for ${inputPath}`);
  }
  return {
    width: res.metadata.width,
    height: res.metadata.height,
    format: res.metadata.format || path.extname(inputPath).replace('.', '').toLowerCase(),
    channels: res.metadata.channels,
    orientation: res.metadata.orientation,
    isRaw: isRawPath(inputPath) || res.metadata.format === 'dng',
  };
}

/** The header-only probe Tier 1 used for in-memory bytes, unchanged for RAW bytes. */
function tier1BufMetadata(m: {
  width: number;
  height: number;
  channels: number;
  orientation: number;
  format: string;
}): ImageMetadata {
  return {
    width: m.width,
    height: m.height,
    format: m.format,
    channels: m.channels,
    orientation: m.orientation,
    isRaw: m.format === 'dng',
  };
}

/**
 * Dimensions, format, orientation and — for an in-memory bitmap or a
 * non-RAW bitmap file path — the richer metadata block: alpha, embedded
 * colour profile, EXIF/ICC/XMP, density (#3507). A `rawInput` pixel buffer
 * or an actual camera RAW file (by extension, or content-sniffed for a
 * bytes input with no filename to route on) keeps Tier 1's cheap header
 * probe unchanged — analyze()'s container-sidecar reader is written and
 * tested against bitmap containers only.
 */
export async function resolveMetadata(state: BuilderState): Promise<ImageMetadata> {
  if (state.rawInput) {
    return {
      width: state.rawInput.width,
      height: state.rawInput.height,
      format: 'raw',
      channels: state.rawInput.channels,
      orientation: 1,
    };
  }

  if (state.inputPath && isRawPath(state.inputPath)) {
    return tier1PathMetadata(state.inputPath);
  }

  if (state.inputBytes) {
    const probe = loadNativeBinding().rasterProbeMetadataBuf(state.inputBytes);
    if (probe.ok && probe.metadata?.format === 'dng') {
      return tier1BufMetadata(probe.metadata);
    }
    return metadataFromReply(await analyzeBytes(state.inputBytes, ['metadata']));
  }

  if (!state.inputPath) {
    throw new Error('No input provided to MapleImageBuilder');
  }
  const bytes = await fs.readFile(state.inputPath);
  return metadataFromReply(await analyzeBytes(bytes, ['metadata']));
}

/** Normalise a raw pixel buffer to a lossless PNG so `analyze()` can decode it. */
function renderRawInputToPng(r: RawPixelInput): Buffer {
  const native = loadNativeBinding();
  const png = native.rasterFromRawRenderBuf(
    r.data,
    r.width,
    r.height,
    r.channels,
    0,
    0,
    0,
    0,
    'png',
    0,
    0,
  );
  if (!png.ok || !png.buffer) {
    throw new Error(png.error || 'Failed to normalise raw pixels for stats');
  }
  return png.buffer;
}

/**
 * Pixel-derived statistics for every channel plus the whole-image numbers
 * (sharp's `stats()`). Ignores any queued resize/composite/etc ops — like
 * `metadata()`, this reads the *input*, matching sharp's own `stats()`
 * (measured: `sharp(png).resize(4,4).stats()` reports the same numbers as
 * `sharp(png).stats()`).
 *
 * A camera RAW file has no pixels to measure until it's been developed —
 * unlike `metadata()`, which stays a header probe for RAW input, `stats()`
 * runs the full RAW-develop pipeline first (recipe/XMP, colour management,
 * the GPU chain), so expect RAW-develop-level cost, not a header-probe one.
 */
export async function resolveStats(state: BuilderState): Promise<ImageStats> {
  if (isRawDevelop(state)) {
    const developed = await rawDevelopToBuffer(state, (out) => rawDevelopToFile(state, out));
    return statsFromReply(await analyzeBytes(developed, ['stats']));
  }
  if (state.rawInput) {
    return statsFromReply(await analyzeBytes(renderRawInputToPng(state.rawInput), ['stats']));
  }
  const bytes = state.inputBytes ?? (state.inputPath ? await fs.readFile(state.inputPath) : null);
  if (!bytes) {
    throw new Error('No input provided to MapleImageBuilder');
  }
  return statsFromReply(await analyzeBytes(bytes, ['stats']));
}

/** `Expected <expected> for <name> but received <actual> of type <t>` — sharp's own wording. */
function invalidParameter(name: string, expected: string, actual: unknown): Error {
  return new Error(
    `Expected ${expected} for ${name} but received ${actual} of type ${typeof actual}`,
  );
}

/** Keep every metadata block from the input (sharp's `keepMetadata`). */
export function applyKeepMetadata(state: BuilderState): void {
  state.metadata.keep = true;
}

/** Keep most metadata and optionally set the orientation or density (sharp's `withMetadata`). */
export function applyWithMetadata(
  state: BuilderState,
  options?: { orientation?: number; density?: number },
): void {
  if (options?.orientation !== undefined) {
    const o = options.orientation;
    if (!Number.isInteger(o) || o < 1 || o > 8) {
      throw invalidParameter('orientation', 'integer between 1 and 8', o);
    }
  }
  if (options?.density !== undefined) {
    const d = options.density;
    if (typeof d !== 'number' || !(d > 0)) {
      throw invalidParameter('density', 'positive number', d);
    }
  }
  state.metadata.keep = true;
  if (options?.orientation !== undefined) {
    state.metadata.orientation = options.orientation;
  }
  if (options?.density !== undefined) {
    state.metadata.density = options.density;
  }
}

/** Embed this EXIF block (a bare TIFF block, starting `II*` or `MM*`). */
export function applyWithExif(state: BuilderState, exif: Uint8Array | Buffer): void {
  state.metadata.exif = state.aux.add(exif);
}

/** Embed this ICC profile. */
export function applyWithIccProfile(state: BuilderState, icc: Uint8Array | Buffer): void {
  state.metadata.icc = state.aux.add(icc);
}

/** Embed this XMP packet. */
export function applyWithXmp(state: BuilderState, xmp: string | Uint8Array | Buffer): void {
  const bytes = typeof xmp === 'string' ? Buffer.from(xmp, 'utf-8') : xmp;
  state.metadata.xmp = state.aux.add(bytes);
}
