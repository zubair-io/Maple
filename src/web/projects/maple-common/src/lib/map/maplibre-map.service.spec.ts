// MapLibreService unit tests (Map T3, #2827).
//
// `MapLibreInstanceFactory` is substituted via `TestBed`'s provider override
// rather than `vi.mock('maplibre-gl', ...)` — see that file's module doc for
// why (a documented, real intermittent-CI-failure class this codebase has
// already hit once with a different SDK). The fake factory below hands back
// a tiny recorder that lets tests inspect what it was constructed with and
// fire a synthetic 'error' event.

import { TestBed } from '@angular/core/testing';
import { of, throwError } from 'rxjs';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MapConfigService, type MapConfig } from '../api/map-config.service';
import { MapLibreInstanceFactory, type MapLibreMapHandle } from './maplibre-instance-factory';
import { MapLibreService } from './maplibre-map.service';

interface FakeMapOptions {
  style: unknown;
}

class FakeMapHandle implements MapLibreMapHandle {
  readonly options: FakeMapOptions;
  removed = false;
  private errorHandler: ((event: { error?: { message: string } }) => void) | null = null;

  constructor(options: FakeMapOptions) {
    this.options = options;
  }

  onError(handler: (event: { error?: { message: string } }) => void): void {
    this.errorHandler = handler;
  }

  // Map T4 (#2828) additions — unused by MapLibreService's own tests, which
  // never touch pins/sources, but required to satisfy the widened
  // interface.
  onMoveEnd(): void {}
  getBounds(): { west: number; south: number; east: number; north: number } {
    return { west: 0, south: 0, east: 0, north: 0 };
  }
  getZoom(): number {
    return 0;
  }
  addSource(): void {}
  setSourceData(): void {}
  addMarker(): { remove(): void } {
    return { remove: () => {} };
  }

  remove(): void {
    this.removed = true;
  }

  triggerError(): void {
    this.errorHandler?.({ error: { message: 'Failed to fetch' } });
  }
}

function configOf(tile_url: string): MapConfig {
  return { tile_url, source: { tile_url: 'default' } };
}

describe('MapLibreService', () => {
  let getConfig: ReturnType<typeof vi.fn>;
  let create: ReturnType<typeof vi.fn>;
  let handles: FakeMapHandle[];
  let service: MapLibreService;
  let container: HTMLElement;

  beforeEach(() => {
    handles = [];
    getConfig = vi.fn();
    create = vi.fn((options: FakeMapOptions) => {
      const handle = new FakeMapHandle(options);
      handles.push(handle);
      return handle;
    });
    TestBed.configureTestingModule({
      providers: [
        { provide: MapConfigService, useValue: { getConfig } },
        { provide: MapLibreInstanceFactory, useValue: { create } },
      ],
    });
    service = TestBed.inject(MapLibreService);
    container = document.createElement('div');
  });

  it('builds a raster style from an XYZ tile-url template', async () => {
    getConfig.mockReturnValue(of(configOf('https://tiles.example/{z}/{x}/{y}.png')));

    await new Promise<void>((resolve) => service.create(container).subscribe(() => resolve()));

    expect(handles).toHaveLength(1);
    const style = handles[0]!.options.style as { sources: Record<string, { tiles: string[] }> };
    expect(style.sources['maple-base-tiles']?.tiles).toEqual([
      'https://tiles.example/{z}/{x}/{y}.png',
    ]);
    expect(service.tilesUnreachable()).toBe(false);
  });

  it('passes a full style JSON URL straight through', async () => {
    getConfig.mockReturnValue(of(configOf('https://styles.example/style.json')));

    await new Promise<void>((resolve) => service.create(container).subscribe(() => resolve()));

    expect(handles[0]!.options.style).toBe('https://styles.example/style.json');
  });

  it('flips tilesUnreachable on a map error without tearing the instance down', async () => {
    getConfig.mockReturnValue(of(configOf('https://tiles.example/{z}/{x}/{y}.png')));
    await new Promise<void>((resolve) => service.create(container).subscribe(() => resolve()));

    handles[0]!.triggerError();

    expect(service.tilesUnreachable()).toBe(true);
    expect(handles[0]!.removed).toBe(false);
  });

  it('still mounts a blank, interactive map and flips tilesUnreachable when the config fetch fails', async () => {
    getConfig.mockReturnValue(throwError(() => new Error('network down')));

    await new Promise<void>((resolve) => service.create(container).subscribe(() => resolve()));

    expect(handles).toHaveLength(1);
    expect(handles[0]!.options.style).toEqual({ version: 8, sources: {}, layers: [] });
    expect(service.tilesUnreachable()).toBe(true);
  });

  it('destroy() removes the current instance', async () => {
    getConfig.mockReturnValue(of(configOf('https://tiles.example/{z}/{x}/{y}.png')));
    await new Promise<void>((resolve) => service.create(container).subscribe(() => resolve()));

    service.destroy();

    expect(handles[0]!.removed).toBe(true);
  });

  it('a fresh create() tears down the previous instance before mounting a new one', async () => {
    getConfig.mockReturnValue(of(configOf('https://tiles.example/{z}/{x}/{y}.png')));
    await new Promise<void>((resolve) => service.create(container).subscribe(() => resolve()));
    const first = handles[0]!;

    await new Promise<void>((resolve) => service.create(container).subscribe(() => resolve()));

    expect(first.removed).toBe(true);
    expect(handles).toHaveLength(2);
  });
});
