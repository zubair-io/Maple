/**
 * Terminal execution for `MapleImageBuilder`: turn the accumulated state into
 * native calls — the recipe pipeline (`runPipeline`) plus the Tier 1
 * decode/tensor entry points that don't go through it. Split out of
 * `builder.ts` for the file-size budget (#3505). `metadata()`/`stats()` and
 * the metadata `with*` methods live in `builder-metadata.ts` (#3507); the
 * RAW-develop terminals live in `builder-raw-develop.ts` (#3504).
 *
 * Every native call below goes through `callNative` (#3508) instead of
 * `loadNativeBinding()` directly, so by default it runs on the in-package
 * worker pool rather than blocking whichever thread calls `toBuffer`/
 * `toFile`/`toRaw`/`toRawRgb`. `runPipeline`, `resolveToRaw` and
 * `resolveTensor` are therefore all `async` now, same as `metadata()`/
 * `stats()` already were.
 */

import * as fs from 'node:fs/promises';
import { callNative } from './worker-pool';
import { lastResizeWidth, stateToRecipe, type BuilderState } from './builder-state';
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

export async function runPipeline(
  state: BuilderState,
  bytes: Uint8Array,
  output: Record<string, unknown>,
): Promise<PipelineOutput> {
  // Resolve file-backed metadata before serializing its final aux offsets.
  await state.aux.resolve();
  const recipe = stateToRecipe(state, output);
  const res = await callNative('rasterPipelineBuf', [
    bytes,
    JSON.stringify(recipe),
    state.aux.bytes(),
  ]);
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

/** Execute the recipe as interleaved RGB8, dropping alpha after all edits. */
export async function resolveToRaw(state: BuilderState): Promise<RawPixels> {
  const bytes = await inputBytes(state);
  if (bytes.length === 0) {
    throw new Error('Input image is empty');
  }
  // Alpha must survive resize/composite/filters. Append its removal to a
  // terminal-local state so subsequent toRawAlpha()/toBuffer() calls retain it.
  const rgbState: BuilderState = {
    ...state,
    ops: [...state.ops, { op: 'removeAlpha' }],
  };
  const out = await runPipeline(rgbState, bytes, { format: 'raw' });
  return {
    data: new Uint8Array(out.buffer.buffer, out.buffer.byteOffset, out.buffer.byteLength),
    width: out.width,
    height: out.height,
    channels: 3,
  };
}

/** Raw Float32Array tensor for AI/ML inference (SCRFD / ArcFace). */
export async function resolveTensor(
  state: BuilderState,
  options?: TensorOptions,
): Promise<TensorResult> {
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

  const res = await callNative('rasterExtractTensor', [bytes, targetSize, layoutNum, normNum]);
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
