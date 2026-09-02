// raw-pipeline.decode-route.spec.ts
//
// Review fix round 1 (epic #2683, Task 9): the worker's `handleLegacyDecode`
// itself is untestable in this harness — it imports the generated
// `./pkg/raw_wasm` glue and installs `addEventListener('message', …)` as a
// module-load side effect. `selectLegacyDecodeRoute` was split out of it
// specifically so the routing DECISION has direct coverage: a filmLut-bearing
// unsized request must route to `'film'` (the CPU film-aware sibling)
// unconditionally, never `'gpu'` (the one-shot GPU entry, which has no
// film-aware sibling), on a GPU-capable browser or not.
//
// PURE spec — no Angular TestBed, no raw-wasm import, no `self`/`navigator`
// stub needed (the capability check is a plain boolean parameter) — mirrors
// raw-pipeline.dispatch-postmessage.spec.ts's "runs under plain `bunx vitest
// run` as well as `ng test`" harness.

import { describe, it, expect } from 'vitest';

import { selectLegacyDecodeRoute } from './raw-pipeline.decode-route';
import type { DecodeRequest } from './raw-pipeline.types';

type Req = Pick<DecodeRequest, 'gpu' | 'maxLongEdge' | 'filmLut'>;

const NO_FILM: Req = { gpu: false, maxLongEdge: undefined, filmLut: undefined };
const FILM_BYTES = new ArrayBuffer(24); // any non-empty buffer stands in for a real .mlut grid
const EMPTY_FILM_BYTES = new ArrayBuffer(0);

describe('selectLegacyDecodeRoute (#2683 Task 9 fix round 1)', () => {
  it('routes a plain unsized request to cpu', () => {
    expect(selectLegacyDecodeRoute(NO_FILM, false)).toBe('cpu');
    expect(selectLegacyDecodeRoute(NO_FILM, true)).toBe('cpu');
  });

  it('routes an unsized, no-film, gpu-opted-in request to gpu ONLY when the runtime advertises WebGPU', () => {
    const req: Req = { ...NO_FILM, gpu: true };
    expect(selectLegacyDecodeRoute(req, true)).toBe('gpu');
    expect(selectLegacyDecodeRoute(req, false)).toBe('cpu');
  });

  it('a sized request routes to sized regardless of gpu opt-in or WebGPU support', () => {
    const req: Req = { ...NO_FILM, gpu: true, maxLongEdge: 1024 };
    expect(selectLegacyDecodeRoute(req, true)).toBe('sized');
    expect(selectLegacyDecodeRoute(req, false)).toBe('sized');
  });

  it('maxLongEdge: 0 is NOT sized (the "no cap" sentinel), matching handleLegacyDecode\'s own check', () => {
    const req: Req = { ...NO_FILM, maxLongEdge: 0 };
    expect(selectLegacyDecodeRoute(req, false)).toBe('cpu');
  });

  // ── THE FIX: a filmLut-bearing unsized request must NEVER reach 'gpu' ──────

  it('a filmLut-bearing unsized request routes to film even when gpu-opted-in on a WebGPU-capable browser', () => {
    const req: Req = { gpu: true, maxLongEdge: undefined, filmLut: FILM_BYTES };
    expect(selectLegacyDecodeRoute(req, true)).toBe('film');
  });

  it('a filmLut-bearing unsized request routes to film with gpu opted out or WebGPU unavailable', () => {
    const req: Req = { gpu: true, maxLongEdge: undefined, filmLut: FILM_BYTES };
    expect(selectLegacyDecodeRoute(req, false)).toBe('film');
    expect(selectLegacyDecodeRoute({ ...req, gpu: false }, true)).toBe('film');
  });

  it('an EMPTY filmLut is treated as "no look" — falls through to gpu/cpu, not film', () => {
    const req: Req = { gpu: true, maxLongEdge: undefined, filmLut: EMPTY_FILM_BYTES };
    expect(selectLegacyDecodeRoute(req, true)).toBe('gpu');
    expect(selectLegacyDecodeRoute(req, false)).toBe('cpu');
  });

  // ── #2719: sized + film now has its own dedicated route ────────────────────

  it('a sized + filmLut request routes to sizedFilm regardless of gpu opt-in or WebGPU support', () => {
    const req: Req = { gpu: true, maxLongEdge: 1024, filmLut: FILM_BYTES };
    expect(selectLegacyDecodeRoute(req, true)).toBe('sizedFilm');
    expect(selectLegacyDecodeRoute(req, false)).toBe('sizedFilm');
    expect(selectLegacyDecodeRoute({ ...req, gpu: false }, true)).toBe('sizedFilm');
  });

  it('a sized request with an EMPTY filmLut routes to plain sized, not sizedFilm', () => {
    const req: Req = { gpu: true, maxLongEdge: 1024, filmLut: EMPTY_FILM_BYTES };
    expect(selectLegacyDecodeRoute(req, true)).toBe('sized');
  });

  it('sizedFilm outranks maxLongEdge: 0 correctly falling back to the film-only route', () => {
    // maxLongEdge: 0 is NOT "sized" (the no-cap sentinel) — a filmLut-bearing
    // request with no real cap still routes to the unsized film entry.
    const req: Req = { gpu: false, maxLongEdge: 0, filmLut: FILM_BYTES };
    expect(selectLegacyDecodeRoute(req, false)).toBe('film');
  });
});
