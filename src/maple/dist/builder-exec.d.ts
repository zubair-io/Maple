/**
 * Terminal execution for `MapleImageBuilder`: turn the accumulated state into
 * native calls — the recipe pipeline (`runPipeline`) plus the Tier 1
 * metadata/decode/tensor entry points that don't go through it. Split out of
 * `builder.ts` for the file-size budget (#3505).
 */
import { type BuilderState } from './builder-state';
import type { ImageMetadata, RawPixels, TensorOptions, TensorResult } from './types';
export interface PipelineOutput {
    buffer: Buffer;
    width: number;
    height: number;
    channels: number;
}
/** Bytes for the current input: raw pixels, an in-memory buffer, or a file. */
export declare function inputBytes(state: BuilderState): Promise<Uint8Array>;
export declare function runPipeline(state: BuilderState, bytes: Uint8Array, output: Record<string, unknown>): PipelineOutput;
/** Dimensions, format and orientation without a full decode. */
export declare function resolveMetadata(state: BuilderState): Promise<ImageMetadata>;
/** Decode to native-size interleaved RGB8 (alpha dropped, grey expanded). */
export declare function resolveToRaw(state: BuilderState): Promise<RawPixels>;
/** Raw Float32Array tensor for AI/ML inference (SCRFD / ArcFace). */
export declare function resolveTensor(state: BuilderState, options?: TensorOptions): Promise<TensorResult>;
