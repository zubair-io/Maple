import { ffiPool } from '../../ffi/ffi-pool.ts';
import type { StageResult } from '../stage-config.ts';

const DECODER_RETRY_MS = 60_000;

/**
 * Thumb and preview renders all run in the FFI child. Without its native
 * library every render fails, and since a failed render is never recorded
 * done (#5474) it would otherwise dead-letter and tag the asset damaged. A
 * missing library is the server's state, not the asset's, so defer instead.
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
