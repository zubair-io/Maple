import { ffiPool } from '../../ffi/ffi-pool.ts';
import { stat } from '../../fs/mirrored.ts';
import type { StageResult } from '../stage-config.ts';

const DECODER_RETRY_MS = 60_000;
const RENDER_RETRY_MS = 30 * 60_000;

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
 * A render that published nothing must not be recorded as done (#5474). The
 * decoder refusing the original is thrown as `SourceDecodeError` before this
 * point, so it alone reaches the retry → dead-letter → damaged path. Any other
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
