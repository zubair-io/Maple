// Out-of-band scope sampling (#3397). Split into its own module for the same
// reason `raw-pipeline.sample-range.types` is: `raw-pipeline.types.ts` is at
// its file budget, and the union there references this via `import(...)`.

import type { ScopeSnapshot } from './raw-pipeline.types';

/**
 * Broadcast (id 0, no pending handler) carrying the downsampled RGB readback of
 * the most recently presented frame, for the scopes.
 *
 * Deliberately NOT folded into `render-session-success`: the readback is a
 * synchronous GPU→CPU sync (`drawImage` off the presented canvas, then
 * `getImageData`), and doing it before posting that reply put the sync inside
 * the acknowledgement the editor's latest-wins scheduler waits on — which is
 * what stalled edit dispatch past the 50ms budget while render/submit itself
 * measured ~3ms.
 *
 * Latest-wins and lossy by design: the worker skips a sample once another
 * render is queued, because that render presents a newer frame and publishes
 * its own. Scopes describe the frame on screen, so dropping a superseded
 * sample is correct rather than merely tolerable.
 */
export interface ScopeSampleBroadcast {
  id: 0;
  type: 'scope-sample';
  scope: ScopeSnapshot;
}
