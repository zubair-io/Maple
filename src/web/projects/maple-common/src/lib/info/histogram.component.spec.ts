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
import type { ApiHistogram } from '../api/bun-api-backend.service';
import { ImageCanvasService } from '../components/image-canvas/image-canvas.service';
import type { DecodedImage } from '../raw-pipeline/raw-pipeline.types';
import type { Asset } from '../models/asset';
import { SERVER_LIBRARY_IO, type ServerLibraryIo } from '../workspace/server-library-io';

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

function makeApiStub(impl: Partial<ServerLibraryIo> = {}): ServerLibraryIo {
  return {
    getHistogram: vi.fn().mockReturnValue(of(emptyHistogram())),
    ...impl,
  } as unknown as ServerLibraryIo;
}

describe('InfoHistogramComponent', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('renders the placeholder when no asset is bound', () => {
    const api = makeApiStub();
    TestBed.configureTestingModule({
      imports: [InfoHistogramComponent],
      providers: [{ provide: SERVER_LIBRARY_IO, useValue: api }],
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
    } as Partial<ServerLibraryIo>);

    TestBed.configureTestingModule({
      imports: [InfoHistogramComponent],
      providers: [{ provide: SERVER_LIBRARY_IO, useValue: api }],
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
    } as Partial<ServerLibraryIo>);

    TestBed.configureTestingModule({
      imports: [InfoHistogramComponent],
      providers: [{ provide: SERVER_LIBRARY_IO, useValue: api }],
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

  it('prefers live local pixels over the server histogram', () => {
    // Server returns an empty (all-zero) histogram; the local snapshot has a
    // hot bin at 255, so if the local path wins we see `255,0.00` — which an
    // empty server histogram (every bin at the baseline y=100) never produces.
    const api = makeApiStub();
    TestBed.configureTestingModule({
      imports: [InfoHistogramComponent],
      providers: [{ provide: SERVER_LIBRARY_IO, useValue: api }],
    });
    const canvas = TestBed.inject(ImageCanvasService);
    const decoded: DecodedImage = {
      width: 2,
      height: 1,
      rgb: new Uint8Array([255, 0, 0, 0, 255, 0]), // red pixel, green pixel
      asShotTemperature: 5500,
      asShotTint: 0,
    };
    canvas.currentPixels.set(decoded);

    const fixture = TestBed.createComponent(InfoHistogramComponent);
    fixture.componentRef.setInput('asset', makeAsset('local-1'));
    fixture.detectChanges();

    const root = fixture.nativeElement as HTMLElement;
    expect(root.querySelector('.placeholder')).toBeNull();
    const polylines = root.querySelectorAll('svg.live polyline');
    expect(polylines.length).toBe(3);
    // R channel: bins 0 and 255 both = 1 (peak), so both sit at the top (y=0).
    const rPoints = (polylines[0] as SVGPolylineElement).getAttribute('points') ?? '';
    expect(rPoints.startsWith('0,0.00')).toBe(true);
    expect(rPoints).toContain('255,0.00');
  });

  it('refetches when the asset id changes', () => {
    const getHistogram = vi.fn().mockReturnValue(of(emptyHistogram()));
    const api = makeApiStub({ getHistogram } as Partial<ServerLibraryIo>);
    TestBed.configureTestingModule({
      imports: [InfoHistogramComponent],
      providers: [{ provide: SERVER_LIBRARY_IO, useValue: api }],
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

  it('does not request a server histogram in Hosted mode', () => {
    TestBed.configureTestingModule({
      imports: [InfoHistogramComponent],
      providers: [{ provide: SERVER_LIBRARY_IO, useValue: null }],
    });
    const fixture = TestBed.createComponent(InfoHistogramComponent);
    fixture.componentRef.setInput('asset', makeAsset('hosted:photo.dng'));
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('.placeholder')).not.toBeNull();
  });
});
