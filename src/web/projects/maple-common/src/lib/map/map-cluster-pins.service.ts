// MapClusterPinsService — the clustered pins / count-bubbles layer for the
// Map view (Map T4, #2828). Provided by `MapViewComponent` itself (not
// `providedIn: 'root'`), so its marker/subscription state lives and dies
// with exactly one map mount — see that component's module doc for why
// `MapLibreService` stays a thin, pin-agnostic wrapper instead of owning
// this.
//
// Drives the SAME `MapLibreMapHandle` `MapLibreService` mounts: feeds the
// shared cluster GeoJSON source (`map-cluster-source.ts` — shared with
// #2829's heatmap layer), and layers DOM markers on top of it — a
// thumbnail pin for a single-photo cell, a count bubble otherwise (design
// doc § "3. Web front-end"). Markers are keyed by cell identity and
// reconciled (not rebuilt) on every fetch — see `reconcileMarkers` —
// because a thumbnail pin's `<img>` is a real network fetch
// (`FilesystemBrowseService.getThumbBlobUrl`, cached, but still a DOM
// create + decode); re-creating every marker on every pan tick would blow
// the render-loop-allocation rule in root CLAUDE.md's performance
// invariants for no reason, since most cells don't change between two
// overlapping viewports.
//
// Search-filter params are intentionally NOT sent yet: no call site today
// threads an active search filter into `<app-map-view>` (Self Hosted's
// browse content mounts it with no inputs — see
// `self-hosted-browse-content.component.html`), so there is nothing to
// forward. Wire it in here once that shared state exists; until then this
// fetches bbox+zoom only, which is everything the current app state
// actually provides.

import { Injectable, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import {
  EMPTY,
  type Observable,
  Subject,
  catchError,
  debounceTime,
  startWith,
  switchMap,
  takeUntil,
} from 'rxjs';
import { FilesystemBrowseService } from '../api/filesystem-browse.service';
import { MapClustersService, type MapCluster } from '../api/map-clusters.service';
import { MAP_CLUSTER_SOURCE_ID, cellsToFeatureCollection } from './map-cluster-source';
import type { MapLibreMapHandle, MapLibreMarkerHandle } from './maplibre-instance-factory';

/** Debounce window between the last pan/zoom tick and the next
 * `/api/map/clusters` fetch — long enough that a drag gesture (many
 * `moveend` ticks in quick succession while MapLibre's inertia settles)
 * issues one request, not one per tick. */
const REFETCH_DEBOUNCE_MS = 300;

/** Fallback search-page query when a cell has no `placeLabel` (design doc §
 * "Error / empty states") — lands the click on the has-GPS scope instead of
 * a no-op. */
const NO_PLACE_LABEL_QUERY_PARAMS = { scope: 'places' } as const;

/** Stable identity for a cell across fetches, used to decide whether a
 * marker can be reused as-is. A single-photo cell keys off the photo
 * itself (`representativeAssetId`) so float-rounding noise in the server's
 * averaged centroid never breaks the match; a multi-count cell has no
 * single photo to key off, so it keys off its rounded position + count —
 * a cell whose membership actually changed is, correctly, a different key
 * and gets a fresh marker. */
function cellKey(cell: MapCluster): string {
  return cell.count === 1
    ? `thumb:${cell.representativeAssetId}`
    : `bubble:${cell.lat.toFixed(5)}:${cell.lng.toFixed(5)}:${cell.count}`;
}

@Injectable()
export class MapClusterPinsService {
  private readonly clustersApi = inject(MapClustersService);
  private readonly fs = inject(FilesystemBrowseService);
  private readonly router = inject(Router);

  private handle: MapLibreMapHandle | null = null;
  private readonly markers = new Map<string, MapLibreMarkerHandle>();
  private readonly moveEnd = new Subject<void>();
  private readonly detached = new Subject<void>();

  /** True once the current viewport's fetch resolved with zero cells —
   * drives the "No photos with location here" notice (design doc §
   * "Error / empty states"). Starts `false` so the notice doesn't flash
   * before the first fetch resolves. */
  readonly empty = signal(false);

  /** Wire this layer onto a freshly-mounted map instance: adds the shared
   * cluster source (empty until the first fetch resolves), fetches once
   * immediately for the initial viewport, and re-fetches (debounced) on
   * every `moveend` after that. */
  attach(handle: MapLibreMapHandle): void {
    this.handle = handle;
    handle.addSource(MAP_CLUSTER_SOURCE_ID, cellsToFeatureCollection([]));
    handle.onMoveEnd(() => this.moveEnd.next());

    this.moveEnd
      .pipe(
        debounceTime(REFETCH_DEBOUNCE_MS),
        startWith(undefined),
        // `switchMap`, not a manual subscribe per move: debouncing limits how
        // OFTEN a fetch starts but never cancels one already in flight, so a
        // slow response for an old viewport could resolve after a fast one for
        // the current viewport and repaint the map with pins from where the
        // user used to be. `switchMap` unsubscribes the superseded request —
        // the same guarantee `MapViewModel`'s generation counter gives on Apple.
        switchMap(() => this.fetchForCurrentViewport()),
        takeUntil(this.detached),
      )
      .subscribe((cells) => this.render(cells));
  }

  /** Tear down this layer's subscriptions and markers. Does NOT touch the
   * map instance itself — `MapLibreService.destroy()`, called by the same
   * `ngOnDestroy` this runs alongside, removes the whole surface (markers
   * included); this only stops in-flight/future work from touching an
   * instance that's going away. */
  detach(): void {
    this.detached.next();
    this.detached.complete();
    for (const marker of this.markers.values()) marker.remove();
    this.markers.clear();
    this.handle = null;
  }

  /** One fetch for whatever the map is showing right now. Never errors: a
   * failure completes empty so the outer `moveEnd` stream survives it, and
   * because nothing is emitted the last good cells stay on the map rather than
   * the viewport clearing (design doc § "Error / empty states"). `catchError`
   * sits INSIDE this inner observable for exactly that reason — on the outer
   * pipe it would tear down the subscription on the first network blip. */
  private fetchForCurrentViewport(): Observable<MapCluster[]> {
    const handle = this.handle;
    if (!handle) return EMPTY;
    const bbox = handle.getBounds();
    const zoom = Math.round(handle.getZoom());
    return this.clustersApi.getClusters(bbox, zoom).pipe(catchError(() => EMPTY));
  }

  private render(cells: MapCluster[]): void {
    const handle = this.handle;
    if (!handle) return;
    handle.setSourceData(MAP_CLUSTER_SOURCE_ID, cellsToFeatureCollection(cells));
    this.empty.set(cells.length === 0);
    this.reconcileMarkers(handle, cells);
  }

  /** Adds markers for newly-seen cells, removes markers for cells that
   * dropped out of the response, and leaves every persisting cell's marker
   * untouched — see the module doc's perf rationale. */
  private reconcileMarkers(handle: MapLibreMapHandle, cells: MapCluster[]): void {
    const seen = new Set<string>();
    for (const cell of cells) {
      const key = cellKey(cell);
      seen.add(key);
      if (this.markers.has(key)) continue;
      const element = this.buildMarkerElement(cell);
      this.markers.set(key, handle.addMarker(element, [cell.lng, cell.lat]));
    }
    for (const [key, marker] of this.markers) {
      if (seen.has(key)) continue;
      marker.remove();
      this.markers.delete(key);
    }
  }

  private buildMarkerElement(cell: MapCluster): HTMLElement {
    const el = document.createElement('button');
    el.type = 'button';
    el.addEventListener('click', () => this.onPinClick(cell));

    if (cell.count === 1) {
      el.className = 'map-pin map-pin--thumb';
      el.setAttribute('aria-label', 'Photo at this location');
      const img = document.createElement('img');
      img.alt = '';
      el.appendChild(img);
      if (cell.thumbKey) {
        void this.fs
          .getThumbBlobUrl(cell.thumbKey)
          .then((url) => {
            img.src = url;
          })
          .catch(() => {
            // No thumbnail — the pin stays visible (empty image box) rather
            // than disappearing; the marker itself is still a valid click
            // target for the place-name navigation below.
          });
      }
      return el;
    }

    el.className = 'map-pin map-pin--count';
    el.setAttribute('aria-label', `${cell.count} photos at this location`);
    el.textContent = String(cell.count);
    return el;
  }

  private onPinClick(cell: MapCluster): void {
    const queryParams = cell.placeLabel
      ? { placeQuery: cell.placeLabel }
      : NO_PLACE_LABEL_QUERY_PARAMS;
    void this.router.navigate(['/search/advanced'], { queryParams });
  }
}
