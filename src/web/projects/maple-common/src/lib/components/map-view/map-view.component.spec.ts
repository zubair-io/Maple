// MapViewComponent unit tests (Map T3, #2827).
//
// `MapLibreService` is faked entirely (no real `maplibre-gl` involved) so
// these tests focus on the component's own contract: mount into its own
// container on init, tear down on destroy, and show the tile-unreachable
// notice without ever unmounting the map surface underneath it.

import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { Subject, of, tap } from 'rxjs';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { MapClusterPinsService } from '../../map/map-cluster-pins.service';
import { MapHeatmapLayerService } from '../../map/map-heatmap-layer.service';
import { MapLibreService } from '../../map/maplibre-map.service';
import { MapViewComponent } from './map-view.component';

describe('MapViewComponent', () => {
  let create: ReturnType<typeof vi.fn>;
  let destroy: ReturnType<typeof vi.fn>;
  let currentHandle: ReturnType<typeof vi.fn>;
  let tilesUnreachable: ReturnType<typeof signal<boolean>>;
  let attach: ReturnType<typeof vi.fn>;
  let detach: ReturnType<typeof vi.fn>;
  let empty: ReturnType<typeof signal<boolean>>;
  let heatmapAttach: ReturnType<typeof vi.fn>;

  const FAKE_HANDLE = { fake: true };

  beforeEach(() => {
    create = vi.fn(() => of(undefined));
    destroy = vi.fn();
    currentHandle = vi.fn(() => FAKE_HANDLE);
    tilesUnreachable = signal(false);
    attach = vi.fn();
    detach = vi.fn();
    empty = signal(false);
    heatmapAttach = vi.fn();
    TestBed.configureTestingModule({
      imports: [MapViewComponent],
      providers: [
        provideRouter([]),
        {
          provide: MapLibreService,
          useValue: { create, destroy, currentHandle, tilesUnreachable },
        },
      ],
    });
    // `MapClusterPinsService`/`MapHeatmapLayerService` are provided directly
    // on `MapViewComponent`'s own decorator (component-scoped, per each
    // service's module doc) rather than at the module level, so overriding
    // them for a test has to go through `overrideComponent` — a
    // module-level provider of the same token would be shadowed by the
    // component's own.
    TestBed.overrideComponent(MapViewComponent, {
      set: {
        providers: [
          { provide: MapClusterPinsService, useValue: { attach, detach, empty } },
          { provide: MapHeatmapLayerService, useValue: { attach: heatmapAttach } },
        ],
      },
    });
  });

  it('mounts the map into its own container on init', () => {
    const fixture = TestBed.createComponent(MapViewComponent);
    fixture.detectChanges();

    expect(create).toHaveBeenCalledOnce();
    const container = create.mock.calls[0]?.[0] as HTMLElement;
    expect(container).toBeInstanceOf(HTMLElement);
    expect(fixture.nativeElement.querySelector('.map-canvas')).toBe(container);
  });

  it('tears the map down when the component is destroyed', () => {
    const fixture = TestBed.createComponent(MapViewComponent);
    fixture.detectChanges();

    fixture.destroy();

    expect(destroy).toHaveBeenCalledOnce();
  });

  // `MapLibreService.create()` resolves the tile-source config over the
  // network before it mounts anything, so a viewMode switch can destroy this
  // component while that fetch is still in flight. The subscription has to be
  // torn down with the component: `MapLibreService` is `providedIn: 'root'`,
  // so a late emission would mount a MapLibre instance onto a detached
  // container and park the handle in an app-lifetime singleton that nothing
  // will ever call `destroy()` on — a permanently leaked WebGL context, and
  // browsers cap how many of those a page may hold.
  it('does not mount the map when destroyed before the config fetch completes', () => {
    const pending = new Subject<void>();
    // `delivered` fires only if the value actually reaches the component's
    // subscriber — an unsubscribed chain never runs the `tap`.
    const delivered = vi.fn();
    create.mockReturnValue(pending.pipe(tap(delivered)));

    const fixture = TestBed.createComponent(MapViewComponent);
    fixture.detectChanges();
    fixture.destroy();

    // The config fetch resolves only after the component is already gone.
    pending.next();

    expect(delivered).not.toHaveBeenCalled();
  });

  it('unsubscribes from the in-flight create() on destroy', () => {
    const pending = new Subject<void>();
    create.mockReturnValue(pending.asObservable());

    const fixture = TestBed.createComponent(MapViewComponent);
    fixture.detectChanges();
    expect(pending.observed).toBe(true);

    fixture.destroy();

    // No subscribers left behind once the component is torn down.
    expect(pending.observed).toBe(false);
  });

  it('shows no notice while tiles are reachable', () => {
    const fixture = TestBed.createComponent(MapViewComponent);
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('[role="alert"]')).toBeNull();
    expect(fixture.nativeElement.querySelector('.map-canvas')).not.toBeNull();
  });

  it('shows an inline notice pointing at the Map settings page without blanking the map surface', () => {
    const fixture = TestBed.createComponent(MapViewComponent);
    fixture.detectChanges();

    tilesUnreachable.set(true);
    fixture.detectChanges();

    const notice = fixture.nativeElement.querySelector('[role="alert"]');
    expect(notice?.textContent).toContain('unreachable');
    expect(notice?.querySelector('a')?.getAttribute('href')).toBe('/settings/map');
    // The failure notice layers over the canvas — it never replaces it.
    expect(fixture.nativeElement.querySelector('.map-canvas')).not.toBeNull();
  });

  // Map T4 (#2828) — pins layer attach/detach + the empty-viewport notice.
  it('attaches the cluster-pins layer to the mounted map handle once create() resolves', () => {
    const fixture = TestBed.createComponent(MapViewComponent);
    fixture.detectChanges();

    expect(attach).toHaveBeenCalledExactlyOnceWith(FAKE_HANDLE);
  });

  it('detaches the cluster-pins layer before tearing the map down', () => {
    const fixture = TestBed.createComponent(MapViewComponent);
    fixture.detectChanges();

    fixture.destroy();

    expect(detach).toHaveBeenCalledOnce();
  });

  // Map T5 (#2829) — heatmap layer attach, and its ordering relative to pins.
  it('attaches the heatmap layer to the mounted map handle once create() resolves', () => {
    const fixture = TestBed.createComponent(MapViewComponent);
    fixture.detectChanges();

    expect(heatmapAttach).toHaveBeenCalledExactlyOnceWith(FAKE_HANDLE);
  });

  it('attaches the heatmap layer before the pins layer, so the heatmap stays underneath in the map’s own layer stack', () => {
    const fixture = TestBed.createComponent(MapViewComponent);
    fixture.detectChanges();

    const heatmapOrder = heatmapAttach.mock.invocationCallOrder[0]!;
    const pinsOrder = attach.mock.invocationCallOrder[0]!;
    expect(heatmapOrder).toBeLessThan(pinsOrder);
  });

  it('does not attach the pins layer when destroyed before the config fetch completes', () => {
    const pending = new Subject<void>();
    create.mockReturnValue(pending.asObservable());

    const fixture = TestBed.createComponent(MapViewComponent);
    fixture.detectChanges();
    fixture.destroy();
    pending.next();

    expect(attach).not.toHaveBeenCalled();
  });

  it('shows the empty-viewport notice without blanking the map surface', () => {
    const fixture = TestBed.createComponent(MapViewComponent);
    fixture.detectChanges();

    empty.set(true);
    fixture.detectChanges();

    const notice = fixture.nativeElement.querySelector('[role="status"]');
    expect(notice?.textContent).toContain('No photos with location here');
    expect(fixture.nativeElement.querySelector('.map-canvas')).not.toBeNull();
  });

  it('suppresses the empty-viewport notice while the tiles-unreachable notice is showing', () => {
    const fixture = TestBed.createComponent(MapViewComponent);
    fixture.detectChanges();

    empty.set(true);
    tilesUnreachable.set(true);
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('[role="status"]')).toBeNull();
  });
});
