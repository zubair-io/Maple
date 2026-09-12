/**
 * Terminal execution for `MapleImageBuilder`: turn the accumulated state into
 * native calls — the recipe pipeline (`runPipeline`) plus the Tier 1
 * decode/tensor entry points that don't go through it. Split out of
 * `builder.ts` for the file-size budget (#3505). `metadata()`/`stats()` and
 * the metadata `with*` methods live in `builder-metadata.ts` (#3507); the
 * RAW-develop terminals live in `builder-raw-develop.ts` (#3504).
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { NativeBinding } from './native';
import { loadNativeBinding } from './native';
import { isRawPath, lastResizeWidth, stateToRecipe, type BuilderState } from './builder-state';
import type { RawPixels, TensorOptions, TensorResult } from './types';

export interface PipelineOutput {
  buffer: Buffer;
  width: number;
  height: number;
  channels: number;
}

/** Bytes for the current input: raw pixels, an in-memory buffer, or a file. */
export async function inputBytes(state: BuilderState): Promise<Uint8Array> {
  if (state.rawInput) {
    return state.rawInput.data;
  }
  if (state.inputBytes) {
    return state.inputBytes;
  }
  if (state.inputPath) {
    return await fs.readFile(state.inputPath);
  }
  throw new Error('No input provided to MapleImageBuilder');
}

export function runPipeline(
  state: BuilderState,
  bytes: Uint8Array,
  output: Record<string, unknown>,
): PipelineOutput {
  const native = loadNativeBinding();
  const recipe = stateToRecipe(state, output);
  const res = native.rasterPipelineBuf(bytes, JSON.stringify(recipe), state.aux.bytes());
  if (
    !res.ok ||
    !res.buffer ||
    res.width === undefined ||
    res.height === undefined ||
    res.channels === undefined
  ) {
    throw new Error(res.error || 'Raster pipeline failed');
  }
  return {
    buffer: res.buffer,
    width: res.width,
    height: res.height,
    channels: res.channels,
  };
}

function decodeRgb8(native: NativeBinding, bytes: Uint8Array, autoOrient: boolean): RawPixels {
  const res = native.rasterDecodeRgb8Buf(bytes, autoOrient);
  if (!res.ok || !res.buffer || res.width === undefined || res.height === undefined) {
    throw new Error(res.error || 'Failed to decode to RGB8');
  }
  return {
    data: new Uint8Array(res.buffer.buffer, res.buffer.byteOffset, res.buffer.byteLength),
    width: res.width,
    height: res.height,
    channels: 3,
  };
}

/** Decode to native-size interleaved RGB8 (alpha dropped, grey expanded). */
export async function resolveToRaw(state: BuilderState): Promise<RawPixels> {
  const native = loadNativeBinding();
  if (state.rawInput) {
    const r = state.rawInput;
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
      throw new Error(png.error || 'Failed to normalise raw pixels');
    }
    return decodeRgb8(native, png.buffer, state.autoOrient);
  }
  const bytes = state.inputBytes ?? (state.inputPath ? await fs.readFile(state.inputPath) : null);
  if (!bytes || bytes.length === 0) {
    throw new Error('Input image is empty');
  }
  return decodeRgb8(native, bytes, state.autoOrient);
}

/** Raw Float32Array tensor for AI/ML inference (SCRFD / ArcFace). */
export async function resolveTensor(
  state: BuilderState,
  options?: TensorOptions,
): Promise<TensorResult> {
  const native = loadNativeBinding();

  let bytes = state.inputBytes;
  if (!bytes && state.inputPath) {
    bytes = await fs.readFile(state.inputPath);
  }
  if (!bytes || bytes.length === 0) {
    throw new Error('Input image is empty');
  }

  const targetSize = options?.targetSize ?? (lastResizeWidth(state) || 640);
  const layoutNum = options?.layout === 'hwc' ? 1 : 0;
  const normNum =
    options?.normalize === 'insightface' ? 1 : options?.normalize === 'zeroToOne' ? 2 : 0;

  const res = native.rasterExtractTensor(bytes, targetSize, layoutNum, normNum);
  if (!res.ok || !res.tensor) {
    throw new Error(res.error || 'Failed to extract tensor');
  }

  return {
    data: res.tensor,
    width: targetSize,
    height: targetSize,
    channels: 3,
  };
}
