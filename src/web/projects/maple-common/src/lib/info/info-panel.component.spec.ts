// InfoPanelComponent — spec coverage for the S6 web Info content.
//
// Covers:
//   • All 4 stock sections render (as mui-ui molecules) with a stub asset.
//   • insideSheet=true shows the inline header + close X; false hides it.
//   • Close X emits `(close)`.
//   • Null asset still renders the section shells (placeholder values).
//   • Rating/flag/keyword edits round-trip through LibraryStateService.
//   • The optional app-provided extension is absent by default and mounts
//     only when the composition root provides one.

import { TestBed } from '@angular/core/testing';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Component, signal } from '@angular/core';

import { of } from 'rxjs';
import { InfoPanelComponent } from './info-panel.component';
import { provideInfoPanelExtension } from './info-panel-extension';
import { LibraryStateService } from '../state/library-state.service';
import { SERVER_LIBRARY_IO } from '../workspace/server-library-io';
import type { ServerLibraryIo, ApiHistogram } from '../workspace/server-library-io';
import type { Asset } from '../models/asset';

const STUB_ASSET: Asset = {
  id: 'asset-1',
  filename: 'IMG_0001.dng',
  folderId: 'folder-1',
  rating: 3,
  flag: 'pick',
  colorLabel: null,
  thumbnailGradient: '',
  aspectRatio: 1.5,
  camera: 'Hasselblad L3D-100c',
  lens: '24-70mm f/2.8',
  aperture: 'f/8.0',
  shutter: '1/250',
  iso: 200,
  focalLength: '35mm',
  capturedAt: '2026-04-01',
  keywords: ['travel', 'paris'],
  gps: { lat: 48.8584, lon: 2.2945 },
  city: 'Paris',
};

class FakeLibraryStateService {
  setFlag = vi.fn();
  setRating = vi.fn();
  setKeywords = vi.fn();
  focusedAssetId = signal<string | undefined>(undefined);
  focusedAsset = signal<Asset | null>(null);
  apiIdFor = vi.fn().mockReturnValue(undefined);
}

@Component({ selector: 'app-test-info-extension', standalone: true, template: 'Extended info' })
class TestInfoExtensionComponent {}

function makeFixture(
  opts: {
    asset?: Asset | null;
    insideSheet?: boolean;
    extension?: boolean;
    serverHistogram?: ApiHistogram;
  } = {},
) {
  TestBed.configureTestingModule({
    imports: [InfoPanelComponent],
    providers: [
      { provide: LibraryStateService, useValue: new FakeLibraryStateService() },
      ...(opts.extension ? [provideInfoPanelExtension(TestInfoExtensionComponent)] : []),
      ...(opts.serverHistogram
        ? [
            {
              provide: SERVER_LIBRARY_IO,
              useValue: {
                getHistogram: () => of(opts.serverHistogram),
              } as unknown as ServerLibraryIo,
            },
          ]
        : []),
    ],
  });
  const fixture = TestBed.createComponent(InfoPanelComponent);
  fixture.componentRef.setInput('asset', opts.asset === undefined ? STUB_ASSET : opts.asset);
  fixture.componentRef.setInput('insideSheet', opts.insideSheet ?? false);
  fixture.detectChanges();
  return fixture;
}

describe('InfoPanelComponent', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('renders the rating/flags, metadata grid, and keyword sections with a stub asset', () => {
    const fixture = makeFixture();
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('mui-rating-flags')).not.toBeNull();
    expect(el.querySelector('mui-label-value-grid')).not.toBeNull();
    expect(el.querySelector('mui-keyword-row')).not.toBeNull();
  });

  it('omits mui-histogram when neither live canvas pixels nor a server histogram are available', () => {
    // mui-histogram (unlike the retired InfoHistogramComponent) has no
    // decorative-placeholder mode, so the panel omits the element entirely
    // rather than rendering an empty plot — no ImageCanvasService pixels
    // and no SERVER_LIBRARY_IO provider in this fixture, so both sources
    // are absent.
    const fixture = makeFixture();
    expect(fixture.nativeElement.querySelector('mui-histogram')).toBeNull();
  });

  it('renders mui-histogram from the server-fallback histogram when the canvas has no live pixels', () => {
    const fixture = makeFixture({
      serverHistogram: { r: [1, 2], g: [3, 4], b: [5, 6] },
    });
    expect(fixture.nativeElement.querySelector('mui-histogram')).not.toBeNull();
  });

  it('seeds rating/flag from the asset and mapped to the mui vocabulary', () => {
    const fixture = makeFixture();
    const ratingFlags = fixture.debugElement.query(
      (d) => d.name === 'mui-rating-flags',
    ).componentInstance;
    expect(ratingFlags.rating()).toBe(3);
    expect(ratingFlags.flag()).toBe('pick');
  });

  it('writes rating changes through LibraryStateService.setRating', () => {
    const fixture = makeFixture();
    const svc = TestBed.inject(LibraryStateService) as unknown as FakeLibraryStateService;
    const stars = fixture.nativeElement.querySelectorAll('mui-rating-flags .star');
    (stars[4] as HTMLButtonElement).click();
    fixture.detectChanges();
    expect(svc.setRating).toHaveBeenCalledWith('asset-1', 5);
  });

  it('writes flag changes through LibraryStateService.setFlag, mapped back to the Asset vocabulary', () => {
    const fixture = makeFixture();
    const svc = TestBed.inject(LibraryStateService) as unknown as FakeLibraryStateService;
    const rejectPill = fixture.nativeElement.querySelectorAll('mui-rating-flags .pill')[2];
    (rejectPill as HTMLButtonElement).click();
    fixture.detectChanges();
    expect(svc.setFlag).toHaveBeenCalledWith('asset-1', 'reject');
  });

  it('writes keyword removals through LibraryStateService.setKeywords', () => {
    const fixture = makeFixture();
    const svc = TestBed.inject(LibraryStateService) as unknown as FakeLibraryStateService;
    const removeBtn = fixture.nativeElement.querySelector('mui-keyword-row .remove');
    (removeBtn as HTMLButtonElement).click();
    fixture.detectChanges();
    expect(svc.setKeywords).toHaveBeenCalledWith('asset-1', ['paris']);
  });

  it('renders the inline header + close button when insideSheet=true', () => {
    const fixture = makeFixture({ insideSheet: true });
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('.info-panel-header')).not.toBeNull();
    expect(el.querySelector('button[aria-label="Close"]')).not.toBeNull();
  });

  it('hides the inline header when insideSheet=false', () => {
    const fixture = makeFixture({ insideSheet: false });
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('.info-panel-header')).toBeNull();
  });

  it('emits (close) when the close button is clicked', () => {
    const fixture = makeFixture({ insideSheet: true });
    const spy = vi.fn();
    fixture.componentInstance.close.subscribe(spy);
    const closeBtn = (fixture.nativeElement as HTMLElement).querySelector(
      'button[aria-label="Close"]',
    ) as HTMLButtonElement;
    closeBtn.click();
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('renders section shells with null asset (placeholder values)', () => {
    const fixture = makeFixture({ asset: null });
    const el = fixture.nativeElement as HTMLElement;
    // The EXIF/GPS label-value grid still renders 8 rows with em-dashes —
    // 8 labels × 2 <mui-text> each (label + value).
    expect(el.querySelectorAll('mui-label-value-grid mui-text').length).toBe(16);
    expect(el.textContent).toContain('—');
  });

  it('does not mount an app extension by default', () => {
    const fixture = makeFixture();
    const el = fixture.nativeElement as HTMLElement;
    expect(el.textContent).not.toContain('Extended info');
  });

  it('mounts the app-provided extension', () => {
    const fixture = makeFixture({ extension: true });
    const el = fixture.nativeElement as HTMLElement;
    expect(el.textContent).toContain('Extended info');
  });
});
