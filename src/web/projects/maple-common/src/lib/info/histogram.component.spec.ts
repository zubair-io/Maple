// InfoHistogramComponent — spec.
//
// Covers the fetch + render lifecycle for the server-rendered histogram
// (closes #633). Three shapes:
//   1. No asset bound — placeholder only, no API call.
//   2. Asset bound + happy fetch — three live polylines, no placeholder.
//   3. Asset bound + error response — falls back to the placeholder.
//
// The polyline-point math is exercised in (2) by checking the spike
// case: a single-bin histogram should render the maximum at y=0 (top
// of the box) and every other bin at y=100 (baseline), proving the
// per-channel normalisation works.

import { TestBed } from '@angular/core/testing';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { of, throwError } from 'rxjs';

import { InfoHistogramComponent } from './histogram.component';
import { BunApiBackendService, type ApiHistogram } from '../api/bun-api-backend.service';
import type { Asset } from '../models/asset';

function makeAsset(id = 'asset-1'): Asset {
  return {
    id,
    filename: 'a.dng',
    folderId: 'folder-1',
    rating: 0,
    flag: 'unflagged',
    colorLabel: null,
    thumbnailGradient: '',
    aspectRatio: 1.5,
  };
}

function emptyHistogram(): ApiHistogram {
  return {
    r: new Array(256).fill(0),
    g: new Array(256).fill(0),
    b: new Array(256).fill(0),
  };
}

function makeApiStub(impl: Partial<BunApiBackendService> = {}): BunApiBackendService {
  return {
    getHistogram: vi.fn().mockReturnValue(of(emptyHistogram())),
    ...impl,
  } as unknown as BunApiBackendService;
}

describe('InfoHistogramComponent', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('renders the placeholder when no asset is bound', () => {
    const api = makeApiStub();
    TestBed.configureTestingModule({
      imports: [InfoHistogramComponent],
      providers: [{ provide: BunApiBackendService, useValue: api }],
    });
    const fixture = TestBed.createComponent(InfoHistogramComponent);
    fixture.detectChanges();

    const root = fixture.nativeElement as HTMLElement;
    expect(root.querySelector('.placeholder')).not.toBeNull();
    expect(root.querySelector('.label')?.textContent).toBe('Histogram');
    expect(root.querySelector('svg.live')).toBeNull();
    expect(api.getHistogram).not.toHaveBeenCalled();
  });

  it('fetches and renders three live polylines when an asset binds', () => {
    // Synthetic histogram: spike at bin 0 on each channel.
    const spike: ApiHistogram = {
      r: new Array(256).fill(0),
      g: new Array(256).fill(0),
      b: new Array(256).fill(0),
    };
    spike.r[0] = 10;
    spike.g[0] = 5;
    spike.b[0] = 7;

    const api = makeApiStub({
      getHistogram: vi.fn().mockReturnValue(of(spike)),
    } as Partial<BunApiBackendService>);

    TestBed.configureTestingModule({
      imports: [InfoHistogramComponent],
      providers: [{ provide: BunApiBackendService, useValue: api }],
    });
    const fixture = TestBed.createComponent(InfoHistogramComponent);
    fixture.componentRef.setInput('asset', makeAsset('asset-42'));
    fixture.detectChanges();

    expect(api.getHistogram).toHaveBeenCalledWith('asset-42');

    const root = fixture.nativeElement as HTMLElement;
    expect(root.querySelector('.placeholder')).toBeNull();
    const polylines = root.querySelectorAll('svg.live polyline');
    expect(polylines.length).toBe(3);

    // Sanity check the normalisation: spike at bin 0 ⇒ y=0, baseline at y=100.
    const rPoints = (polylines[0] as SVGPolylineElement).getAttribute('points') ?? '';
    expect(rPoints.startsWith('0,0.00')).toBe(true);
    expect(rPoints).toContain('1,100.00');
  });

  it('falls back to the placeholder when the API errors', () => {
    const api = makeApiStub({
      getHistogram: vi.fn().mockReturnValue(throwError(() => new Error('503'))),
    } as Partial<BunApiBackendService>);

    TestBed.configureTestingModule({
      imports: [InfoHistogramComponent],
      providers: [{ provide: BunApiBackendService, useValue: api }],
    });
    const fixture = TestBed.createComponent(InfoHistogramComponent);
    fixture.componentRef.setInput('asset', makeAsset('asset-err'));
    fixture.detectChanges();

    expect(api.getHistogram).toHaveBeenCalledWith('asset-err');
    const root = fixture.nativeElement as HTMLElement;
    // Live svg never rendered; placeholder visible.
    expect(root.querySelector('svg.live')).toBeNull();
    expect(root.querySelector('.placeholder')).not.toBeNull();
  });

  it('refetches when the asset id changes', () => {
    const getHistogram = vi.fn().mockReturnValue(of(emptyHistogram()));
    const api = makeApiStub({ getHistogram } as Partial<BunApiBackendService>);
    TestBed.configureTestingModule({
      imports: [InfoHistogramComponent],
      providers: [{ provide: BunApiBackendService, useValue: api }],
    });
    const fixture = TestBed.createComponent(InfoHistogramComponent);
    fixture.componentRef.setInput('asset', makeAsset('one'));
    fixture.detectChanges();
    fixture.componentRef.setInput('asset', makeAsset('two'));
    fixture.detectChanges();
    expect(getHistogram).toHaveBeenCalledTimes(2);
    expect(getHistogram).toHaveBeenNthCalledWith(1, 'one');
    expect(getHistogram).toHaveBeenNthCalledWith(2, 'two');
  });
});
