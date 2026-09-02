// raw-pipeline.decode-route.ts
//
// Pure route selection for `handleLegacyDecode` (raw-pipeline.worker.ts),
// split out so it is unit-testable WITHOUT importing the worker entry itself
// (which imports the generated `./pkg/raw_wasm` glue and installs
// `addEventListener('message', …)` as a module-load side effect — neither of
// which a plain vitest spec can safely exercise; see
// raw-pipeline.decode-route.spec.ts for the "no wasm, no worker-global" test
// harness this split enables). No wasm import, no worker-global reference —
// pure boolean logic over the request shape.
//
// Review fix round 1 (epic #2683, Task 9): a film-LUT-bearing unsized decode
// must NEVER route to the GPU one-shot entry (`render_bytes_gpu` has no
// film-aware sibling — only the persistent `WebLiveSession` carries a loaded
// look), on a GPU-capable browser OR as the GPU-adapter-failure fallback.
// This function is the single source of truth for that gate; both call
// sites in `handleLegacyDecode` (the initial dispatch AND the `catch`
// fallback) key off the SAME `film` route rather than re-deriving the
// film-presence check independently, so the two can't drift out of sync
// again.
//
// #2719: a sized request carrying a film LUT now has its own dedicated
// `sizedFilm` route (`render_bytes_sized_with_film`) instead of silently
// dropping the look — the non-WebGPU live canvas's fast/refine phases are
// sized requests, so without this route a loaded film look never rendered
// live on a browser without WebGPU (it only reached the canvas via export
// or the GPU live session).

import type { DecodeRequest } from './raw-pipeline.types';

/** Which WASM entry `handleLegacyDecode` should call. */
export type LegacyDecodeRoute = 'gpu' | 'sizedFilm' | 'sized' | 'film' | 'cpu';

/**
 * Select the route for an unsized-vs-sized, GPU-vs-CPU, look-vs-no-look
 * legacy decode request. `gpuAdvertised` is the runtime capability check
 * (`'gpu' in navigator`) — passed in rather than read here so this stays
 * pure and callable from a spec with no `navigator` stub.
 *
 * Precedence (see the module doc for why `film` outranks `gpu`):
 * 1. `gpu` — unsized, no film LUT, the request opts in, and the runtime
 *    advertises WebGPU.
 * 2. `sizedFilm` — BOTH a `maxLongEdge` cap and a non-empty `filmLut` ride
 *    the request (#2719).
 * 3. `sized` — a `maxLongEdge` cap was requested with no film LUT.
 * 4. `film` — a non-empty `filmLut` rides the (unsized) request.
 * 5. `cpu` — the byte-for-byte legacy no-GPU, no-look path.
 */
export function selectLegacyDecodeRoute(
  req: Pick<DecodeRequest, 'gpu' | 'maxLongEdge' | 'filmLut'>,
  gpuAdvertised: boolean,
): LegacyDecodeRoute {
  const sized = req.maxLongEdge !== undefined && req.maxLongEdge > 0;
  const hasFilmLut = !!req.filmLut && req.filmLut.byteLength > 0;
  if (!sized && !hasFilmLut && req.gpu && gpuAdvertised) return 'gpu';
  if (sized && hasFilmLut) return 'sizedFilm';
  if (sized) return 'sized';
  if (hasFilmLut) return 'film';
  return 'cpu';
}
