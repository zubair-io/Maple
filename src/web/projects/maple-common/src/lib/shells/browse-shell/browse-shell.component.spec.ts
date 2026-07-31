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
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { signal } from '@angular/core';

import { BrowseShellComponent } from './browse-shell.component';
import { LIBRARY_BACKEND } from '../../api/library-backend.token';
import { API_BASE_URL } from '../../api/api-base-url.token';
import { STORAGE_KEYS } from '../../util/typed-storage';
import { provideHostedWorkspace } from '../../workspace/hosted-workspace.providers';
import { provideSelfHostedWorkspace } from '../../workspace/self-hosted-workspace.providers';
import { LibraryStateService } from '../../state/library-state.service';
import { LayoutService, type MapleLayout } from '../../layout-service';
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

// `layout` stubs `LayoutService.layout` as a plain signal — same shape as
// the real service's `Signal<MapleLayout>` — so specs can drive the
// tablet/desktop/phone structural branches without touching `window.innerWidth`.
// Defaults to 'desktop' so the pre-existing (layout-agnostic) tests above
// keep exercising the same DOM shape they always have.
function setupHosted(layout: MapleLayout = 'desktop') {
  TestBed.configureTestingModule({
    providers: [
      provideRouter([]),
      provideHttpClient(),
      provideHttpClientTesting(),
      provideHostedWorkspace(),
      { provide: LIBRARY_BACKEND, useValue: 'hosted' },
      { provide: API_BASE_URL, useValue: '/api' },
      { provide: LayoutService, useValue: { layout: signal<MapleLayout>(layout) } },
    ],
  });
}

function setupSelfHosted(layout: MapleLayout = 'desktop') {
  TestBed.configureTestingModule({
    providers: [
      provideRouter([]),
      provideHttpClient(),
      provideHttpClientTesting(),
      provideSelfHostedWorkspace(),
      { provide: LIBRARY_BACKEND, useValue: 'self-hosted' },
      { provide: API_BASE_URL, useValue: '/api' },
      { provide: LayoutService, useValue: { layout: signal<MapleLayout>(layout) } },
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

// ---------------------------------------------------------------------------
// BrowseShell fluid — source sidebar drawer + toolbar overflow (#2280)
//
// The source sidebar is an inline pane at tablet+ and an overlay drawer
// (`app-source-picker-drawer`) at phone width; the toolbar's action pills
// collapse into a kebab menu below the desktop breakpoint. Both switches key
// off `LayoutService.layout()`, stubbed per-test via `setupSelfHosted(layout)`.
// ---------------------------------------------------------------------------

describe('BrowseShellComponent — responsive layout (#2280)', () => {
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

  function createAndFlush(layout: MapleLayout) {
    setupSelfHosted(layout);
    const fixture = TestBed.createComponent(BrowseShellComponent);
    http = TestBed.inject(HttpTestingController);
    fixture.detectChanges();
    http.match(() => true).forEach((r) => r.flush([]));
    fixture.detectChanges();
    return fixture;
  }

  it('renders the inline source sidebar (not the hamburger) at desktop', () => {
    const fixture = createAndFlush('desktop');

    expect(fixture.nativeElement.querySelector('[data-testid="source-sidebar"]')).not.toBeNull();
    expect(fixture.nativeElement.querySelector('[data-testid="source-drawer-toggle"]')).toBeNull();
  });

  it('renders the inline source sidebar at tablet too', () => {
    const fixture = createAndFlush('tablet');

    expect(fixture.nativeElement.querySelector('[data-testid="source-sidebar"]')).not.toBeNull();
    expect(fixture.nativeElement.querySelector('[data-testid="source-drawer-toggle"]')).toBeNull();
  });

  it('hides the inline sidebar and renders the hamburger at phone width', () => {
    const fixture = createAndFlush('phone');

    expect(fixture.nativeElement.querySelector('[data-testid="source-sidebar"]')).toBeNull();
    expect(
      fixture.nativeElement.querySelector('[data-testid="source-drawer-toggle"]'),
    ).not.toBeNull();
  });

  it('opens the source-picker drawer when the hamburger is tapped', () => {
    const fixture = createAndFlush('phone');
    const component = fixture.componentInstance;

    expect(component.sourceDrawerOpen()).toBe(false);
    expect(fixture.nativeElement.querySelector('[data-testid="source-picker-drawer"]')).toBeNull();

    (
      fixture.nativeElement.querySelector(
        '[data-testid="source-drawer-toggle"]',
      ) as HTMLButtonElement
    ).click();
    fixture.detectChanges();

    expect(component.sourceDrawerOpen()).toBe(true);
    expect(
      fixture.nativeElement.querySelector('[data-testid="source-picker-drawer"]'),
    ).not.toBeNull();
  });

  it('routes a drawer source selection through the shared selectSidebarEntry helper', () => {
    const fixture = createAndFlush('phone');
    const state = TestBed.inject(LibraryStateService);
    const subfolderSpy = vi.spyOn(state, 'openSelfHostedSubfolder');

    // A plain id (no ':' / no absPath in the tree) is a plain source select —
    // the same branch FolderTreeComponent.onFolderClick takes for smart/album/
    // legacy roots, now shared via `selectSidebarEntry`. No subfolder fetch.
    fixture.componentInstance.onDrawerSourceSelected('legacy-root');

    expect(state.selectedSourceId()).toBe('legacy-root');
    expect(subfolderSpy).not.toHaveBeenCalled();
  });

  it('drawer selection of an addressed folder fetches its subfolder (FS-walk branch)', () => {
    const fixture = createAndFlush('phone');
    const state = TestBed.inject(LibraryStateService);
    const subfolderSpy = vi.spyOn(state, 'openSelfHostedSubfolder');
    const setFolderOpenSpy = vi.spyOn(state, 'setFolderOpen');

    // An addressed id (`slug:relPath`) takes the FS-walk branch: load the
    // directory's contents + expand it in the tree, in one shot.
    fixture.componentInstance.onDrawerSourceSelected('lib:2026/trip');

    expect(subfolderSpy).toHaveBeenCalledTimes(1);
    expect(subfolderSpy.mock.calls[0]![1]).toBe('lib:2026/trip');
    expect(setFolderOpenSpy).toHaveBeenCalledWith('lib:2026/trip', true);
  });

  it('shows the inline action pills (no kebab) at desktop width', () => {
    const fixture = createAndFlush('desktop');

    expect(
      fixture.nativeElement.querySelector('[data-testid="toolbar-overflow-toggle"]'),
    ).toBeNull();
    expect(fixture.nativeElement.querySelector('[aria-label="Copy settings"]')).not.toBeNull();
  });

  it('collapses the action pills into a kebab menu below the desktop breakpoint', () => {
    const fixture = createAndFlush('tablet');

    const toggle = fixture.nativeElement.querySelector(
      '[data-testid="toolbar-overflow-toggle"]',
    ) as HTMLButtonElement;
    expect(toggle).not.toBeNull();
    // Pills aren't in the DOM until the menu is opened.
    expect(fixture.nativeElement.querySelector('[aria-label="Copy settings"]')).toBeNull();
    expect(fixture.nativeElement.querySelector('[data-testid="toolbar-overflow-menu"]')).toBeNull();

    toggle.click();
    fixture.detectChanges();

    expect(
      fixture.nativeElement.querySelector('[data-testid="toolbar-overflow-menu"]'),
    ).not.toBeNull();
    expect(fixture.nativeElement.querySelector('[aria-label="Copy settings"]')).not.toBeNull();
  });

  it('closes the overflow menu after an action pill inside it is clicked', () => {
    const fixture = createAndFlush('tablet');
    const state = TestBed.inject(LibraryStateService);

    // Copy Settings is disabled without a focused asset — a disabled
    // button doesn't dispatch a click event at all, so give it one to
    // exercise the real click → bubble-to-menu-container path.
    state.focusedAssetId.set('asset-1');
    fixture.detectChanges();

    const toggle = fixture.nativeElement.querySelector(
      '[data-testid="toolbar-overflow-toggle"]',
    ) as HTMLButtonElement;
    toggle.click();
    fixture.detectChanges();

    const copyBtn = fixture.nativeElement.querySelector(
      '[aria-label="Copy settings"]',
    ) as HTMLButtonElement;
    expect(copyBtn).not.toBeNull();
    expect(copyBtn.disabled).toBe(false);
    copyBtn.click();
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('[data-testid="toolbar-overflow-menu"]')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Select mode (#2404) — the toolbar's Select pill toggles
// LibraryStateService.isSelecting, and Escape exits the mode without
// touching the selection (the batch-metadata / pano / paste pills are
// enabled off selectedCount(), so clearing on exit would defeat the mode).
// ---------------------------------------------------------------------------

describe('BrowseShellComponent — Select mode (#2404)', () => {
  let http: HttpTestingController;
  let originalResize: unknown;
  let originalIntersection: unknown;

  beforeEach(() => {
    const g = globalThis as { ResizeObserver?: unknown; IntersectionObserver?: unknown };
    originalResize = g.ResizeObserver;
    originalIntersection = g.IntersectionObserver;
    const observerStub = class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    };
    g.ResizeObserver = observerStub;
    g.IntersectionObserver = observerStub;
  });

  afterEach(() => {
    // Put the globals back (including `undefined`, jsdom's actual starting
    // state) so the stubs don't leak into whatever runs next.
    const g = globalThis as { ResizeObserver?: unknown; IntersectionObserver?: unknown };
    g.ResizeObserver = originalResize;
    g.IntersectionObserver = originalIntersection;
    try {
      http.verify();
    } catch {
      // Swallow stray expectations from heavy child components.
    }
  });

  function createAndFlush() {
    setupSelfHosted('desktop');
    const fixture = TestBed.createComponent(BrowseShellComponent);
    http = TestBed.inject(HttpTestingController);
    fixture.detectChanges();
    http.match(() => true).forEach((r) => r.flush([]));
    fixture.detectChanges();
    return fixture;
  }

  it('clicking the Select pill toggles LibraryStateService.isSelecting', () => {
    const fixture = createAndFlush();
    const state = TestBed.inject(LibraryStateService);
    expect(state.isSelecting()).toBe(false);

    const selectBtn = fixture.nativeElement.querySelector(
      '[aria-label="Select"]',
    ) as HTMLButtonElement;
    expect(selectBtn).not.toBeNull();

    selectBtn.click();
    fixture.detectChanges();
    expect(state.isSelecting()).toBe(true);

    selectBtn.click();
    fixture.detectChanges();
    expect(state.isSelecting()).toBe(false);
  });

  it('Escape exits Select mode without clearing the selection', () => {
    const fixture = createAndFlush();
    const state = TestBed.inject(LibraryStateService);
    state.toggleSelectMode();
    state.selectAsset('asset-1' as never);
    expect(state.isSelecting()).toBe(true);
    expect(state.selectedAssetIds().has('asset-1' as never)).toBe(true);

    // Dispatched on `document` (not called directly) so `e.target` is a real
    // element — onKeydown reads `e.target as HTMLElement` unconditionally,
    // same as a real keypress the @HostListener('document:keydown') binding
    // would receive.
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    fixture.detectChanges();

    expect(state.isSelecting()).toBe(false);
    // Selection survives — leaving the mode must not clear it.
    expect(state.selectedAssetIds().has('asset-1' as never)).toBe(true);
  });

  it('Escape is a no-op when Select mode is already off', () => {
    const fixture = createAndFlush();
    const state = TestBed.inject(LibraryStateService);
    expect(state.isSelecting()).toBe(false);

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    fixture.detectChanges();

    expect(state.isSelecting()).toBe(false);
  });
});
