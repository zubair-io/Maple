// FilmLutService — lazy asset delivery for film-look `.mlut` grids
// (epic #2683, Task 12).
//
// The 100-entry catalog (`film-catalog.generated.ts`) ships as tiny TS data
// (id/name/category); the grids themselves are NOT bundled — `angular.json`
// serves them from `resources/film-luts/*.mlut` under `/film-luts/`, and
// `ngsw-config*.json` caches them lazily (`dataGroups`, `performance`
// strategy) so the service worker only ever downloads a look once per
// device. `getLattice` adds a second, faster tier in front of that: an
// IndexedDB write-through cache (`FilmLutIdbCache`) so a same-session
// re-selection of a look never round-trips through the network stack at
// all, not even to the SW cache.
//
// Never throws: a missing/broken `.mlut` degrades to "no look applied"
// (`null` + a console warning) rather than breaking the render — the
// canvas/session glue (`image-canvas.film.ts`) treats `null` as "clear the
// session's film LUT", which is byte-identical to a session that never
// loaded one.

import { Injectable, inject } from '@angular/core';
import { FILM_LUT_CACHE, type FilmLutCache } from './film-lut-idb-cache';

@Injectable({ providedIn: 'root' })
export class FilmLutService {
  private readonly cache: FilmLutCache = inject(FILM_LUT_CACHE);

  /**
   * Resolve `lookId`'s `.mlut` v1 bytes: IDB cache hit → return; miss →
   * `fetch('/film-luts/<id>.mlut')` → cache the result → return. An empty
   * `lookId` (the model's "no look selected" default) short-circuits to
   * `null` without touching the cache or the network — mirrors
   * `AdjustmentModel.filmLook`'s '' sentinel.
   *
   * A 404 (retired/renamed catalog id) or any fetch failure resolves `null`
   * and logs a warning — never throws, so a stale sidecar referencing a
   * look this build no longer ships can't break the render.
   */
  async getLattice(lookId: string): Promise<ArrayBuffer | null> {
    if (!lookId) return null;

    const cached = await this.cache.get(lookId);
    if (cached) return cached;

    try {
      const response = await fetch(`/film-luts/${lookId}.mlut`);
      if (!response.ok) {
        console.warn(`[film-lut] ${lookId}.mlut fetch failed: HTTP ${response.status}`);
        return null;
      }
      const bytes = await response.arrayBuffer();
      await this.cache.put(lookId, bytes);
      return bytes;
    } catch (err) {
      console.warn(`[film-lut] ${lookId}.mlut fetch threw:`, err);
      return null;
    }
  }
}

/**
 * FNV-1a 32-bit hash of `lookId`, folded into the GPU chain's bind-group
 * bucket key (`SetFilmLutRequest.lookKey`, `WebLiveSession::set_film_lut`'s
 * `look_key`). The Rust side treats the key as fully opaque — a
 * content-identity value the host chooses, not a value it recomputes or
 * validates — so any stable, well-distributed hash of the id satisfies the
 * contract; FNV-1a is picked for being a few lines of integer math with no
 * dependency. `0` is raw-core's internal "no look loaded" sentinel
 * (`clear_film_lut` sets `film_lut_key = 0`), so a hash that lands on it is
 * bumped to `1` — collision-free against every other id in the 100-entry
 * catalog (verified: no `FILM_CATALOG` id hashes to 0).
 */
export function filmLutKey(lookId: string): number {
  let hash = 0x811c9dc5; // FNV offset basis (32-bit)
  for (let i = 0; i < lookId.length; i++) {
    hash ^= lookId.charCodeAt(i);
    // hash *= 0x01000193 (FNV prime), via shifts to stay in 32-bit ints.
    hash = Math.imul(hash, 0x01000193);
  }
  const unsigned = hash >>> 0;
  return unsigned === 0 ? 1 : unsigned;
}
