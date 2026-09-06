import { signal } from '@angular/core';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideHttpClient } from '@angular/common/http';
import { TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { Router, provideRouter } from '@angular/router';
import { CdkDropList, CdkDropListGroup } from '@angular/cdk/drag-drop';
import { PERSISTED_BATCH_SYNC } from '../../editor/copy-paste/persisted-batch-sync';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LayoutService, type MapleLayout } from '../../layout-service';
import { LibraryStateService } from '../../state/library-state.service';
import { ASSET_RENAME_CAPABILITY } from '../../rename/asset-rename-capability';
import { STORAGE_KEYS } from '../../util/typed-storage';
import { provideHostedWorkspace } from '../../workspace/hosted-workspace.providers';
import { BrowseShellComponent } from './browse-shell.component';
import type { Asset } from '../../models/asset';

function clearPreferences(): void {
  for (const key of Object.values(STORAGE_KEYS)) localStorage.removeItem(key);
}

describe('BrowseShellComponent capability boundary', () => {
  let http: HttpTestingController;
  let layout: ReturnType<typeof signal<MapleLayout>>;
  let originalResizeObserver: unknown;
  let originalIntersectionObserver: unknown;

  beforeEach(async () => {
    clearPreferences();
    const globals = globalThis as {
      ResizeObserver?: unknown;
      IntersectionObserver?: unknown;
    };
    originalResizeObserver = globals.ResizeObserver;
    originalIntersectionObserver = globals.IntersectionObserver;
    const observer = class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    };
    globals.ResizeObserver = observer;
    globals.IntersectionObserver = observer;
    layout = signal<MapleLayout>('desktop');
    await TestBed.configureTestingModule({
      imports: [BrowseShellComponent],
      providers: [
        provideRouter([]),
        provideHttpClient(),
        provideHttpClientTesting(),
        provideHostedWorkspace(),
        {
          provide: PERSISTED_BATCH_SYNC,
          useValue: {
            progress: signal(null),
            lastSummary: signal(null),
            error: signal(null),
            remaining: signal([]),
            needsReconnect: signal(false),
          },
        },
        { provide: LayoutService, useValue: { layout } },
      ],
    }).compileComponents();
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    try {
      http.verify();
    } finally {
      const globals = globalThis as {
        ResizeObserver?: unknown;
        IntersectionObserver?: unknown;
      };
      globals.ResizeObserver = originalResizeObserver;
      globals.IntersectionObserver = originalIntersectionObserver;
      clearPreferences();
    }
  });

  it('renders only browser-backed Browse composition by default', () => {
    const fixture = TestBed.createComponent(BrowseShellComponent);
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('app-drop-zone')).not.toBeNull();
    expect(fixture.nativeElement.querySelector('app-asset-grid')).not.toBeNull();
    expect(fixture.nativeElement.querySelector('[aria-label="View mode"]')).toBeNull();
    expect(fixture.nativeElement.querySelector('[aria-label="Edit metadata"]')).toBeNull();
    expect(fixture.nativeElement.querySelector('[aria-label="Add folder"]')).toBeNull();
    expect(fixture.nativeElement.querySelector('app-library-picker-modal')).toBeNull();
    expect(fixture.nativeElement.textContent).not.toContain('Merge to panorama');
    expect(http.match(() => true)).toEqual([]);
  });

  it('switches from the inline sidebar to the source drawer at phone width', () => {
    const fixture = TestBed.createComponent(BrowseShellComponent);
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('[data-testid="source-sidebar"]')).not.toBeNull();
    expect(fixture.nativeElement.querySelector('[data-testid="source-drawer-toggle"]')).toBeNull();

    layout.set('tablet');
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('[data-testid="source-sidebar"]')).not.toBeNull();

    layout.set('phone');
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('[data-testid="source-sidebar"]')).toBeNull();
    const toggle = fixture.nativeElement.querySelector(
      '[data-testid="source-drawer-toggle"] button',
    ) as HTMLButtonElement;
    toggle.click();
    fixture.detectChanges();

    expect(fixture.componentInstance.sourceDrawerOpen()).toBe(true);
    expect(
      fixture.nativeElement.querySelector('[data-testid="source-picker-drawer"]'),
    ).not.toBeNull();
  });

  it('routes plain and addressed drawer selections through shared source selection', () => {
    layout.set('phone');
    const fixture = TestBed.createComponent(BrowseShellComponent);
    fixture.detectChanges();
    const state = TestBed.inject(LibraryStateService);
    const openSubfolder = vi.spyOn(state, 'openSelfHostedSubfolder');
    const setFolderOpen = vi.spyOn(state, 'setFolderOpen');

    fixture.componentInstance.onDrawerSourceSelected('legacy-root');
    expect(state.selectedSourceId()).toBe('legacy-root');
    expect(openSubfolder).not.toHaveBeenCalled();

    fixture.componentInstance.onDrawerSourceSelected('library:2026/trip');
    expect(openSubfolder).toHaveBeenCalledWith('2026/trip', 'library:2026/trip');
    expect(setFolderOpen).toHaveBeenCalledWith('library:2026/trip', true);
  });

  it('keeps shared select-mode keyboard behavior', () => {
    const fixture = TestBed.createComponent(BrowseShellComponent);
    fixture.detectChanges();
    const state = fixture.componentInstance.state;
    const select = fixture.nativeElement.querySelector(
      '[aria-label="Select"]',
    ) as HTMLButtonElement;
    select.click();
    state.selectAsset('asset-1' as never);

    expect(state.isSelecting()).toBe(true);

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    fixture.detectChanges();

    expect(state.isSelecting()).toBe(false);
    expect(state.selectedAssetIds().has('asset-1' as never)).toBe(true);
  });

  it('F2 opens the inline-rename field for the focused asset (#2637)', async () => {
    // Provides a local fake for ASSET_RENAME_CAPABILITY rather than spying
    // on the shared NOOP_CAPABILITY singleton the token's default factory
    // returns — spying on that module-level object would leak a mock into
    // every other spec that resolves the same default. Re-runs the module
    // setup from `beforeEach` (`TestBed.inject` there already instantiated
    // the module, and `overrideProvider` cannot run post-instantiation) with
    // this one extra provider added.
    clearPreferences();
    const startEditing = vi.fn();
    TestBed.resetTestingModule();
    await TestBed.configureTestingModule({
      imports: [BrowseShellComponent],
      providers: [
        provideRouter([]),
        provideHttpClient(),
        provideHttpClientTesting(),
        provideHostedWorkspace(),
        {
          provide: PERSISTED_BATCH_SYNC,
          useValue: {
            progress: signal(null),
            lastSummary: signal(null),
            error: signal(null),
            remaining: signal([]),
            needsReconnect: signal(false),
          },
        },
        { provide: LayoutService, useValue: { layout } },
        {
          provide: ASSET_RENAME_CAPABILITY,
          useValue: {
            editingAssetId: signal(null),
            error: signal(null),
            busy: signal(false),
            collision: signal(null),
            disabledReason: () => null,
            startEditing,
            cancel: vi.fn(),
            commit: vi.fn(),
            resolveCollision: vi.fn(),
          },
        },
      ],
    }).compileComponents();
    http = TestBed.inject(HttpTestingController);
    const fixture = TestBed.createComponent(BrowseShellComponent);
    fixture.detectChanges();
    const state = fixture.componentInstance.state;
    const asset: Asset = {
      id: 'library:2026/IMG_0001.CR3',
      filename: 'IMG_0001.CR3',
      folderId: 'library:2026',
      rating: 0,
      flag: 'unflagged',
      colorLabel: null,
      thumbnailGradient: '',
      aspectRatio: 1.5,
    };
    vi.spyOn(state, 'focusedAssetId').mockReturnValue(asset.id as never);
    vi.spyOn(state, 'focusedAsset').mockReturnValue(asset);

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'F2', bubbles: true }));
    fixture.detectChanges();

    expect(startEditing).toHaveBeenCalledWith(asset);
  });

  // #2724 review — a pointer drag from a grid tile onto a folder-tree row
  // never worked: an earlier version put `[cdkDropListConnectedTo]` on the
  // folder ROWS pointing at the grid's id, but CDK's `connectedTo` is
  // directional (it grants THAT list's own items entry into the named
  // targets), so it let folder rows' empty item set enter the grid — never
  // the reverse. The fix is a single `cdkDropListGroup` on the ancestor in
  // `browse-shell.component.html` that wraps both the sidebar and the
  // content area, which CDK's own drag-drop source (`beforeStarted`,
  // `drag-drop.mjs`) resolves by unioning the STARTING list's own
  // `connectedTo` with every OTHER member of `this._group._items` — so
  // group membership, not `connectedTo`, is what actually has to be right.
  //
  // Simulating the full pointer gesture (mousedown/pointermove/pointerup)
  // was not viable here: CDK's drop-target resolution depends on real
  // element geometry from `getBoundingClientRect`, which jsdom (this
  // project's unit-test DOM) always reports as a zero-size rect — the
  // gesture would "complete" without ever exercising the geometry-based
  // containment check that's actually load-bearing for this bug class.
  // Instead this asserts the RESOLVED wiring the gesture depends on: the
  // real `CdkDropListGroup` instance browse-shell renders actually
  // contains BOTH the grid's tile container and a folder-tree row as
  // members, which is precisely the fact CDK's own `beforeStarted` handler
  // reads to decide what a drag can enter. A future regression that
  // reintroduces a one-way `connectedTo`, drops the group off the
  // ancestor, or scopes it to the wrong element breaks this test.
  it('connects the asset-grid tile drop-list and a folder-tree row drop-list into one CdkDropListGroup (#2724)', () => {
    const fixture = TestBed.createComponent(BrowseShellComponent);
    // Setting `selectedSourceId` directly (rather than through the normal
    // selection flow) fires browse-shell's own "mirror selection into the
    // URL" effect against this spec's route-less `provideRouter([])` —
    // irrelevant to what this test verifies, so it's stubbed out rather
    // than left to reject unhandled.
    vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
    const state = fixture.componentInstance.state;
    const folderId = 'library:2026';
    state.sidebarTree.set([{ kind: 'folder', id: folderId, label: '2026', count: null }]);
    state.selectedSourceId.set(folderId);
    state.assets.set([
      {
        id: `${folderId}/IMG_0001.CR3`,
        filename: 'IMG_0001.CR3',
        folderId,
        rating: 0,
        flag: 'unflagged',
        colorLabel: null,
        thumbnailGradient: '',
        aspectRatio: 1.5,
      },
    ]);
    fixture.detectChanges();
    fixture.detectChanges();

    const groupDebugEl = fixture.debugElement.query(By.directive(CdkDropListGroup));
    expect(groupDebugEl).not.toBeNull();
    const group = groupDebugEl.injector.get(CdkDropListGroup);

    const gridDropListDebugEl = fixture.debugElement.query(
      By.css('[id="maple-asset-grid-drop-list"]'),
    );
    const rowDropListDebugEl = fixture.debugElement.query(By.css(`[id="folder-drop-${folderId}"]`));
    expect(gridDropListDebugEl).not.toBeNull();
    expect(rowDropListDebugEl).not.toBeNull();

    const gridDropList = gridDropListDebugEl.injector.get(CdkDropList);
    const rowDropList = rowDropListDebugEl.injector.get(CdkDropList);

    expect(group._items.has(gridDropList)).toBe(true);
    expect(group._items.has(rowDropList)).toBe(true);
  });
});
