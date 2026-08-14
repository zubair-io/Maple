// MapLibreInstanceFactory — the only file in maple-common that imports the
// `maplibre-gl` SDK's runtime code (Map T3, #2827).
//
// Exists purely so `MapLibreService` — the actual owner of map
// lifecycle/config-resolution logic, and the file with real unit test
// coverage — can depend on this via Angular DI and get swapped for a fake
// in tests, instead of leaning on `vi.mock('maplibre-gl', ...)`. That
// module-mocking shape depends on Vitest correctly intercepting a
// third-party package's own module resolution, which has already
// reproduced a real, intermittent CI failure for a different SDK in this
// codebase — see `exif-reader.service.ts`'s module doc for the incident.
// Routing the SDK call itself through DI sidesteps that whole class of
// flake: nothing for a test to race against, and jsdom (which has no real
// WebGL context) never has to construct a real `maplibregl.Map`.
import { Injectable } from '@angular/core';
import { Map as MapLibreMap, type MapOptions } from 'maplibre-gl';

/** The subset of `maplibregl.Map`'s API `MapLibreService` actually uses —
 * kept narrow so a test fake only has to implement these two members. */
export interface MapLibreMapHandle {
  on(event: 'error', handler: (event: { error?: { message: string } }) => void): void;
  remove(): void;
}

@Injectable({ providedIn: 'root' })
export class MapLibreInstanceFactory {
  create(options: MapOptions): MapLibreMapHandle {
    return new MapLibreMap(options);
  }
}
