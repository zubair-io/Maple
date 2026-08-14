// MapViewComponent unit tests (Map T3, #2827).
//
// `MapLibreService` is faked entirely (no real `maplibre-gl` involved) so
// these tests focus on the component's own contract: mount into its own
// container on init, tear down on destroy, and show the tile-unreachable
// notice without ever unmounting the map surface underneath it.

import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { of } from 'rxjs';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { MapLibreService } from '../../map/maplibre-map.service';
import { MapViewComponent } from './map-view.component';

describe('MapViewComponent', () => {
  let create: ReturnType<typeof vi.fn>;
  let destroy: ReturnType<typeof vi.fn>;
  let tilesUnreachable: ReturnType<typeof signal<boolean>>;

  beforeEach(() => {
    create = vi.fn(() => of(undefined));
    destroy = vi.fn();
    tilesUnreachable = signal(false);
    TestBed.configureTestingModule({
      imports: [MapViewComponent],
      providers: [
        provideRouter([]),
        { provide: MapLibreService, useValue: { create, destroy, tilesUnreachable } },
      ],
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
});
