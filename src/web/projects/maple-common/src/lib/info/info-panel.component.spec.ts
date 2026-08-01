// InfoPanelComponent — spec coverage for the S6 web Info content.
//
// Covers:
//   • All 4 stock sections render with a stub asset.
//   • insideSheet=true shows the inline header + close X; false hides it.
//   • Close X emits `(close)`.
//   • Null asset still renders the section shells (placeholder values).
//   • The enrichment surface is gated by `LIBRARY_BACKEND` (#634):
//     hidden on Hosted, rendered on Self-Hosted (orchestrator child
//     `<app-info-enrichment>` mounts when the backend reports
//     `self-hosted`).

import { TestBed } from '@angular/core/testing';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { signal } from '@angular/core';
import { of } from 'rxjs';

import { InfoPanelComponent } from './info-panel.component';
import { LibraryStateService } from '../state/library-state.service';
import { LIBRARY_BACKEND } from '../api/library-backend.token';
import { BunApiBackendService } from '../api/bun-api-backend.service';
import { SERVER_LIBRARY_IO } from '../workspace/server-library-io';
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

class FakeBunApiBackendService {
  // Empty-list status keeps the orchestrator quiet; no requeue / fetch
  // calls fire because `apiIdFor` returns undefined on the fake state.
  getWorkerStatus = vi.fn().mockReturnValue(of({ stages: [] }));
  getAssetDetails = vi.fn();
  setAssetPlaceOverride = vi.fn();
  setAssetDescriptionOverride = vi.fn();
  requeueEnrichmentStage = vi.fn();
  // InfoHistogramComponent injects BunApiBackendService now (#633) — stub
  // getHistogram so the InfoPanel spec doesn't pull the real HttpClient surface.
  getHistogram = vi
    .fn()
    .mockReturnValue(
      of({ r: new Array(256).fill(0), g: new Array(256).fill(0), b: new Array(256).fill(0) }),
    );
}

function makeFixture(
  opts: {
    asset?: Asset | null;
    insideSheet?: boolean;
    backend?: 'hosted' | 'self-hosted';
  } = {},
) {
  TestBed.configureTestingModule({
    imports: [InfoPanelComponent],
    providers: [
      { provide: LibraryStateService, useValue: new FakeLibraryStateService() },
      { provide: BunApiBackendService, useValue: new FakeBunApiBackendService() },
      { provide: SERVER_LIBRARY_IO, useExisting: BunApiBackendService },
      { provide: LIBRARY_BACKEND, useValue: opts.backend ?? 'hosted' },
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

  it('hides the enrichment surface on Hosted backend', () => {
    const fixture = makeFixture({ backend: 'hosted' });
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('[data-testid="info-enrichment"]')).toBeNull();
  });

  it('mounts the enrichment surface on Self-Hosted backend', () => {
    const fixture = makeFixture({ backend: 'self-hosted' });
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('[data-testid="info-enrichment"]')).not.toBeNull();
  });
});
