// InfoPanelComponent — spec coverage for the S6 web Info content.
//
// Covers:
//   • All 4 stock sections render with a stub asset.
//   • insideSheet=true shows the inline header + close X; false hides it.
//   • Close X emits `(close)`.
//   • Null asset still renders the section shells (placeholder values).
//   • The optional app-provided extension is absent by default and mounts
//     only when the composition root provides one.

import { TestBed } from '@angular/core/testing';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Component, signal } from '@angular/core';

import { InfoPanelComponent } from './info-panel.component';
import { provideInfoPanelExtension } from './info-panel-extension';
import { LibraryStateService } from '../state/library-state.service';
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
  } = {},
) {
  TestBed.configureTestingModule({
    imports: [InfoPanelComponent],
    providers: [
      { provide: LibraryStateService, useValue: new FakeLibraryStateService() },
      ...(opts.extension ? [provideInfoPanelExtension(TestInfoExtensionComponent)] : []),
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

  it('renders all 4 sections with a stub asset', () => {
    const fixture = makeFixture();
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('[data-testid="info-rating-flags"]')).not.toBeNull();
    expect(el.querySelector('[data-testid="info-histogram"]')).not.toBeNull();
    expect(el.querySelector('[data-testid="info-camera-location"]')).not.toBeNull();
    expect(el.querySelector('[data-testid="info-keywords"]')).not.toBeNull();
  });

  it('renders the inline header + close button when insideSheet=true', () => {
    const fixture = makeFixture({ insideSheet: true });
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('.info-panel-header')).not.toBeNull();
    expect(el.querySelector('[data-testid="info-panel-close"]')).not.toBeNull();
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
      '[data-testid="info-panel-close"]',
    ) as HTMLButtonElement;
    closeBtn.click();
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('renders section shells with null asset (placeholder values)', () => {
    const fixture = makeFixture({ asset: null });
    const el = fixture.nativeElement as HTMLElement;
    // Camera/Location grid still renders 8 rows with em-dashes.
    const rows = el.querySelectorAll('[data-testid^="info-row-"]');
    expect(rows.length).toBe(8);
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
