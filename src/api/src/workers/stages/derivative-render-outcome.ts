import { ffiPool } from '../../ffi/ffi-pool.ts';
import { DecodeMemoryBudgetError } from '../../ffi/decode-memory-budget.ts';
import { UnsupportedCameraError } from '../../ffi/unsupported-camera.ts';
import { stat } from '../../fs/mirrored.ts';
import { child as childLogger } from '../../log.ts';
import { NoVideoStreamError } from '../../thumbs/source-failure.ts';
import type { StageResult } from '../stage-config.ts';

const log = childLogger('workers:derivative-render');

const DECODER_RETRY_MS = 60_000;
const RENDER_RETRY_MS = 30 * 60_000;
const UNSUPPORTED_CAMERA_RETRY_MS = 24 * 60 * 60_000;

/**
 * Thumb and preview renders all run in the FFI child. Without its native
 * library every render fails, and that is the server's state, not the
 * asset's, so defer rather than spend attempts.
 */
export function deferWhileDecoderMissing(): StageResult | null {
  return ffiPool().available()
    ? null
    : {
        defer: {
          reason: 'derivative-ffi-unavailable',
          retryAt: new Date(Date.now() + DECODER_RETRY_MS),
        },
      };
}

/**
 * A render that published nothing must not be recorded as done (#5474). A
 * decoder refusing the original is thrown as `SourceDecodeError` before this
 * point (`thumbs/source-failure.ts` lists the signatures), so only it reaches
 * the retry → dead-letter → damaged path. Any other
 * failure — a full or read-only cache volume, an encode fault, a crashed
 * child — says nothing about the original, so it defers and resumes once the
 * server recovers. A vanished original rethrows its own ENOENT so the runner
 * tags it missing.
 */
export async function unrenderedOutcome(
  rendered: boolean,
  sourcePath: string,
): Promise<StageResult | null> {
  if (rendered) return null;
  await stat(sourcePath);
  return {
    defer: {
      reason: 'derivative-render-produced-no-file',
      retryAt: new Date(Date.now() + RENDER_RETRY_MS),
    },
  };
}

/**
 * A RAW with no embedded preview whose camera body the decoder does not know
 * (#5499) has nothing to render from in this build. The original is intact —
 * a build that supports the body renders it — so this defers without spending
 * an attempt rather than dead-lettering into `damaged`.
 */
export function unsupportedCameraDeferral(err: unknown, sourcePath: string): StageResult | null {
  if (!(err instanceof UnsupportedCameraError)) return null;
  log.warn({ sourcePath, err: err.message }, 'render deferred: camera body is not supported');
  return {
    defer: {
      reason: 'camera-unsupported',
      retryAt: new Date(Date.now() + UNSUPPORTED_CAMERA_RETRY_MS),
    },
  };
}

/**
 * A video container with no video stream (an audio-only MXF, #5513) has no
 * frame for any build to render: the stage is done with nothing to publish,
 * and the original is not damaged.
 */
export function noVideoStreamOutcome(err: unknown): StageResult | null {
  return err instanceof NoVideoStreamError ? { skip: 'no-video-stream' } : null;
}

/**
 * A decode estimated larger than the whole decode memory budget (#5467) is a
 * server setting, not a property of the file: defer without spending an
 * attempt, so raising the budget (or setting it to 0) lets the asset render.
 */
export function memoryBudgetDeferral(err: unknown, sourcePath: string): StageResult | null {
  if (!(err instanceof DecodeMemoryBudgetError)) return null;
  log.warn({ sourcePath, err: err.message }, 'render deferred: decode exceeds the memory budget');
  return {
    defer: {
      reason: 'decode-exceeds-memory-budget',
      retryAt: new Date(Date.now() + RENDER_RETRY_MS),
    },
  };
}
