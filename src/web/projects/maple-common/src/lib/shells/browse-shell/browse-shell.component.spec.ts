// BrowseShell — toggle visibility test (S5/S2) + onEditMetadata regression (#1666).
//
// Verifies the Folder/Timeline segmented control:
//   - is rendered in Self-Hosted mode
//   - is hidden in Hosted mode
//   - uses aria-pressed (not aria-checked) on its buttons (S5 accessibility)
//
// Also verifies the regression that the "Edit Metadata…" button silently did
// nothing for address-keyed assets (asset.id = "slug:relPath") because the old
// code tried to resolve abs paths via absPathFor (always undefined) and a.absPath
// (also undefined for modern assets), so the dialog never opened.
//
// Heavy child components are not the focus here — we exercise the shell's
// branching behaviour. The initial loadFolderTree() request is flushed to
// keep the HttpTestingController clean.

import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting, HttpTestingController } from '@angular/common/http/testing';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { signal } from '@angular/core';

import { BrowseShellComponent } from './browse-shell.component';
import { LIBRARY_BACKEND } from '../../api/library-backend.token';
import { API_BASE_URL } from '../../api/api-base-url.token';
import { STORAGE_KEYS } from '../../util/typed-storage';
import { provideLibrarySource } from '../../addressing/library-source-provider';
import { LibraryStateService } from '../../state/library-state.service';
import type { Asset } from '../../models/asset';

// This spec constructs the real BrowsePreferencesService (via
// BrowseShellComponent → LibraryStateService); its persistence effects write
// `cm.*` keys into the jsdom localStorage that vitest shares across spec
// files on a worker. Clear them around each test so nothing leaks into
// sibling spec files (#1142).
const clearPrefKeys = (): void => {
  for (const key of Object.values(STORAGE_KEYS)) localStorage.removeItem(key);
};
beforeEach(clearPrefKeys);
afterEach(clearPrefKeys);

function setupHosted() {
  TestBed.configureTestingModule({
    providers: [
      provideRouter([]),
      provideHttpClient(),
      provideHttpClientTesting(),
      provideLibrarySource,
      { provide: LIBRARY_BACKEND, useValue: 'hosted' },
      { provide: API_BASE_URL, useValue: '/api' },
    ],
  });
}

function setupSelfHosted() {
  TestBed.configureTestingModule({
    providers: [
      provideRouter([]),
      provideHttpClient(),
      provideHttpClientTesting(),
      provideLibrarySource,
      { provide: LIBRARY_BACKEND, useValue: 'self-hosted' },
      { provide: API_BASE_URL, useValue: '/api' },
    ],
  });
}

describe('BrowseShellComponent — Folder/Timeline toggle', () => {
  let http: HttpTestingController;

  beforeEach(() => {
    // jsdom lacks ResizeObserver/IntersectionObserver — child components
    // (asset-grid etc.) construct one in ngAfterViewInit. Stub them.
    const observerStub = class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    };
    (globalThis as { ResizeObserver?: unknown }).ResizeObserver = observerStub;
    (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver = observerStub;
  });

  afterEach(() => {
    try {
      http.verify();
    } catch {
      // Swallow stray expectations from heavy child components — we only
      // care about the toggle DOM here, not the full request graph.
    }
  });

  it('renders the toggle when backend is self-hosted', () => {
    setupSelfHosted();
    const fixture = TestBed.createComponent(BrowseShellComponent);
    http = TestBed.inject(HttpTestingController);
    fixture.detectChanges();
    // Flush the loadFolderTree() request kicked off by ngOnInit.
    http.match(() => true).forEach((r) => r.flush([]));
    fixture.detectChanges();

    const toggle = fixture.nativeElement.querySelector('[aria-label="View mode"]');
    expect(toggle).not.toBeNull();
    const buttons = toggle!.querySelectorAll('button');
    expect(buttons.length).toBe(2);
    expect(buttons[0]!.textContent?.trim()).toContain('Folder');
    expect(buttons[1]!.textContent?.trim()).toContain('Timeline');
  });

  it('uses aria-pressed (not aria-checked) for accessibility (S5)', () => {
    setupSelfHosted();
    const fixture = TestBed.createComponent(BrowseShellComponent);
    http = TestBed.inject(HttpTestingController);
    fixture.detectChanges();
    http.match(() => true).forEach((r) => r.flush([]));
    fixture.detectChanges();

    const toggle = fixture.nativeElement.querySelector('[aria-label="View mode"]');
    const buttons = toggle!.querySelectorAll('button');
    for (const b of Array.from(buttons) as HTMLButtonElement[]) {
      expect(b.hasAttribute('aria-pressed')).toBe(true);
      expect(b.hasAttribute('aria-checked')).toBe(false);
    }
    // role on the wrapper should be group, not radiogroup.
    expect(toggle!.getAttribute('role')).toBe('group');
  });

  it('hides the toggle when backend is hosted', () => {
    setupHosted();
    const fixture = TestBed.createComponent(BrowseShellComponent);
    http = TestBed.inject(HttpTestingController);
    fixture.detectChanges();
    // Hosted shouldn't kick off folder enumeration; flush anything anyway.
    http.match(() => true).forEach((r) => r.flush([]));
    fixture.detectChanges();

    const toggle = fixture.nativeElement.querySelector('[aria-label="View mode"]');
    expect(toggle).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Regression: onEditMetadata opens the dialog for address-keyed assets (#1666)
//
// The old code resolved abs paths via absPathFor (always undefined in production
// for slug:relPath assets) and a.absPath (also undefined). This caused paths[]
// to always be empty, so the dialog never opened. The fix sends asset.id as the
// address directly; this test confirms batchMetaDialogVisible() becomes true.
// ---------------------------------------------------------------------------

describe('BrowseShellComponent — onEditMetadata regression (#1666)', () => {
  let http: HttpTestingController;

  beforeEach(() => {
    const observerStub = class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    };
    (globalThis as { ResizeObserver?: unknown }).ResizeObserver = observerStub;
    (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver = observerStub;
  });

  afterEach(() => {
    try {
      http.verify();
    } catch {
      // Swallow stray expectations from heavy child components.
    }
  });

  it('opens the batch-metadata dialog for address-keyed assets (slug:relPath ids)', () => {
    setupSelfHosted();
    const fixture = TestBed.createComponent(BrowseShellComponent);
    http = TestBed.inject(HttpTestingController);
    fixture.detectChanges();

    // Flush the initial loadFolderTree() request.
    http.match(() => true).forEach((r) => r.flush([]));
    fixture.detectChanges();

    const component = fixture.componentInstance;
    const state = TestBed.inject(LibraryStateService);

    // Stub the state signals to simulate two selected address-keyed assets.
    // The asset ids use the slug:relPath scheme (no absPath, no assetAbsPaths entry).
    const assetA = { id: 'photos:2026/IMG_0001.dng' } as unknown as Asset;
    const assetB = { id: 'photos:2026/IMG_0002.dng' } as unknown as Asset;

    Object.defineProperty(state, 'selectedAssetIds', {
      value: signal(new Set([assetA.id, assetB.id])),
      configurable: true,
    });
    Object.defineProperty(state, 'assetsInSelectedFolder', {
      value: signal([assetA, assetB]),
      configurable: true,
    });

    // onEditMetadata() should not bail out — dialog must become visible.
    component.onEditMetadata();

    // Flush the POST /api/metadata/snapshots call with address keys.
    const snapshotsCall = http.expectOne('/api/metadata/snapshots');
    expect(snapshotsCall.request.body).toEqual({
      addresses: ['photos:2026/IMG_0001.dng', 'photos:2026/IMG_0002.dng'],
    });
    snapshotsCall.flush({
      snapshots: [
        { address: 'photos:2026/IMG_0001.dng', metadata: {} },
        { address: 'photos:2026/IMG_0002.dng', metadata: {} },
      ],
    });
    fixture.detectChanges();

    expect(component.batchMetaDialogVisible()).toBe(true);
    expect(component.batchMetaAssetSnapshots()).toHaveLength(2);
    expect(component.batchMetaAssetSnapshots()[0]!.address).toBe('photos:2026/IMG_0001.dng');
  });

  it('falls back to the thin snapshot when the API call fails, and still opens the dialog', () => {
    setupSelfHosted();
    const fixture = TestBed.createComponent(BrowseShellComponent);
    http = TestBed.inject(HttpTestingController);
    fixture.detectChanges();
    http.match(() => true).forEach((r) => r.flush([]));
    fixture.detectChanges();

    const component = fixture.componentInstance;
    const state = TestBed.inject(LibraryStateService);

    const assetA = {
      id: 'photos:2026/IMG_0003.dng',
      gps: { lat: 48.8, lon: 2.3 },
      city: 'Paris',
    } as unknown as Asset;

    Object.defineProperty(state, 'selectedAssetIds', {
      value: signal(new Set([assetA.id])),
      configurable: true,
    });
    Object.defineProperty(state, 'assetsInSelectedFolder', {
      value: signal([assetA]),
      configurable: true,
    });

    component.onEditMetadata();

    // Fail the snapshots request — should fall back to thin snapshot.
    http
      .expectOne('/api/metadata/snapshots')
      .flush('error', { status: 500, statusText: 'Server Error' });
    fixture.detectChanges();

    // Dialog still opens with the thin fallback.
    expect(component.batchMetaDialogVisible()).toBe(true);
    expect(component.batchMetaAssetSnapshots()).toHaveLength(1);
    expect(component.batchMetaAssetSnapshots()[0]!.address).toBe('photos:2026/IMG_0003.dng');
  });
});
