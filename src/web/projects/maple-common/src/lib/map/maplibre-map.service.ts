// MapLibreService — thin wrapper around the `maplibre-gl` SDK (Map T3, #2827).
//
// Owns map-instance creation/teardown and resolves the style/tile URL from
// the operator's tile-source setting (`map-config.service.ts`, #2826). Kept
// behind this service (and, one layer further down, `MapLibreInstanceFactory`
// — see that file's module doc for why the actual `new Map(...)` call lives
// there instead of here) so the component tree never imports `maplibre-gl`
// directly — `MapViewComponent` is the only consumer.
//
// Tile-failure handling (design doc § "Error / empty states" —
// docs/superpowers/specs/2026-08-14-photo-map-view-design.md): a broken or
// unreachable tile source must not blank the map surface. MapLibre builds
// the canvas and attaches its pan/zoom/drag handlers synchronously when the
// map instance is constructed, before any style or tile ever loads over the
// network — so the surface is interactive the moment `create()` mounts the
// instance, independent of whether imagery ever arrives. Tile/style fetch
// failures surface separately via `tilesUnreachable()` so the caller can
// show an inline notice without tearing anything down.
import { Injectable, inject, signal } from '@angular/core';
import type { StyleSpecification } from 'maplibre-gl';
import { Observable, catchError, map, of } from 'rxjs';
import { MapConfigService } from '../api/map-config.service';
import { MapLibreInstanceFactory, type MapLibreMapHandle } from './maplibre-instance-factory';

const BASE_SOURCE_ID = 'maple-base-tiles';
const BASE_LAYER_ID = 'maple-base-layer';

/** A style with no sources/layers — still a valid MapLibre style, so the map
 * comes up pannable/zoomable over a blank canvas when there is no usable
 * tile URL at all (e.g. the config fetch itself failed). */
const EMPTY_STYLE: StyleSpecification = { version: 8, sources: {}, layers: [] };

/**
 * `tile_url` is either a raw XYZ raster template (contains the literal
 * `{z}` placeholder) or a full MapLibre style JSON URL — see
 * `map-config.repo.ts`'s module doc on the API side. Only the raster case
 * needs a style built client-side; a style URL is passed straight through
 * as `Map`'s `style` option.
 */
function styleFor(tileUrl: string): StyleSpecification | string {
  if (!tileUrl.includes('{z}')) return tileUrl;
  return {
    version: 8,
    sources: {
      [BASE_SOURCE_ID]: {
        type: 'raster',
        tiles: [tileUrl],
        tileSize: 256,
        attribution: '© OpenStreetMap contributors',
      },
    },
    layers: [{ id: BASE_LAYER_ID, type: 'raster', source: BASE_SOURCE_ID }],
  };
}

@Injectable({ providedIn: 'root' })
export class MapLibreService {
  private readonly mapConfig = inject(MapConfigService);
  private readonly factory = inject(MapLibreInstanceFactory);

  private instance: MapLibreMapHandle | null = null;

  private readonly _tilesUnreachable = signal(false);

  /** Flips true the moment either the tile-source config fetch or the map's
   * own base tile source reports an error. Sticky for the instance's
   * lifetime — a fresh attempt only happens when `create()` runs again
   * (e.g. after the operator updates the setting and the view remounts).
   * Read-only to consumers: this service is `providedIn: 'root'`, so a
   * writable handle would let any injector flip another view's state. */
  readonly tilesUnreachable = this._tilesUnreachable.asReadonly();

  /**
   * Create a map inside `container` using the configured tile source.
   * Always resolves — a config-fetch failure or a bad tile URL flips
   * `tilesUnreachable` and falls back to a blank-but-interactive style
   * rather than erroring the caller out.
   */
  create(container: HTMLElement): Observable<void> {
    this._tilesUnreachable.set(false);
    return this.mapConfig.getConfig().pipe(
      map((config) => config.tile_url),
      catchError(() => {
        this._tilesUnreachable.set(true);
        return of(null);
      }),
      map((tileUrl) => this._mount(container, tileUrl)),
    );
  }

  /** Tear down the current map instance, if any. Safe to call repeatedly —
   * from `create()` before mounting a fresh one, and from the component's
   * `ngOnDestroy`. */
  destroy(): void {
    this.instance?.remove();
    this.instance = null;
  }

  private _mount(container: HTMLElement, tileUrl: string | null): void {
    this.destroy();
    const instance = this.factory.create({
      container,
      style: tileUrl ? styleFor(tileUrl) : EMPTY_STYLE,
      center: [0, 20],
      zoom: 1.5,
    });
    // Any post-construction 'error' on this instance is, in practice, the
    // one base tile source failing to fetch (network failure, 404s, or —
    // when `tile_url` is a style JSON URL rather than a raster template —
    // the style document itself failing to load). MapLibre's `ErrorEvent`
    // carries no `sourceId` to filter on more precisely, and this style
    // never has more than the one source, so any error here means the
    // configured tile source needs operator attention.
    instance.on('error', () => this._tilesUnreachable.set(true));
    this.instance = instance;
  }
}
