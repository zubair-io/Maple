// asset-grid.component.spec.ts — grid click semantics (#2404, #2976).
//
// Apple's BrowseGrid goes straight to Preview on a single tap; Web used to
// require a double-click. This spec guards the replacement contract: a
// plain click selects AND navigates to `/view/…`, Cmd/Ctrl-click and
// Shift-click each mutate the selection without navigating, and while
// Select mode is on a click toggles membership (Shift still range-extends
// — #2976) and never navigates. Folder tiles (#2976) share the same
// gestures, with plain-click drilling into the folder instead of
// navigating to Preview.
//
// Exercises `onThumbClick` directly against a constructed component
// instance (same pattern as editor-shell.component.spec.ts's route-
// resolution tests) rather than rendering the cdk-virtual-scroll template —
// the click handler's branching is pure logic over its injected collaborators
// and doesn't need a DOM render to prove out.

import { signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { AssetGridComponent } from './asset-grid.component';
import { LibraryStateService } from '../../state/library-state.service';
import type { Asset, AssetId } from '../../models/asset';

function makeAsset(id: string): Asset {
  return { id: id as AssetId, filename: `${id}.jpg` } as Asset;
}

function click(opts: Partial<Pick<MouseEvent, 'metaKey' | 'ctrlKey' | 'shiftKey'>> = {}) {
  return {
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    ...opts,
  } as MouseEvent;
}

describe('AssetGridComponent — click semantics (#2404)', () => {
  let selectAsset: ReturnType<typeof vi.fn>;
  let selectFolder: ReturnType<typeof vi.fn>;
  let openSelfHostedSubfolder: ReturnType<typeof vi.fn>;
  let setFolderOpen: ReturnType<typeof vi.fn>;
  let navigate: ReturnType<typeof vi.fn>;
  let isSelecting: boolean;
  let component: AssetGridComponent;

  const asset = makeAsset('a1.jpg');
  const folder = {
    id: 'lib:2026/France',
    name: 'France',
    parentSourceId: 'lib:2026',
    aspectRatio: 1,
  };

  beforeEach(() => {
    selectAsset = vi.fn();
    selectFolder = vi.fn();
    openSelfHostedSubfolder = vi.fn();
    setFolderOpen = vi.fn();
    navigate = vi.fn();
    isSelecting = false;

    TestBed.configureTestingModule({
      providers: [
        {
          provide: LibraryStateService,
          useValue: {
            isSelecting: () => isSelecting,
            selectAsset,
            selectFolder,
            openSelfHostedSubfolder,
            setFolderOpen,
          },
        },
        { provide: Router, useValue: { navigate } },
      ],
    });

    component = TestBed.runInInjectionContext(() => new AssetGridComponent());
  });

  it('a plain click selects and navigates to /view/…', () => {
    component.onThumbClick(asset, click());

    expect(selectAsset).toHaveBeenCalledWith('a1.jpg', false, false);
    expect(navigate).toHaveBeenCalledTimes(1);
    // fs:/no-colon ids pass through as a single segment (route-address.ts).
    expect(navigate).toHaveBeenCalledWith(['/view', 'a1.jpg']);
  });

  it('Cmd-click toggles selection and does not navigate', () => {
    component.onThumbClick(asset, click({ metaKey: true }));

    expect(selectAsset).toHaveBeenCalledWith('a1.jpg', true, false);
    expect(navigate).not.toHaveBeenCalled();
  });

  it('Ctrl-click toggles selection and does not navigate', () => {
    component.onThumbClick(asset, click({ ctrlKey: true }));

    expect(selectAsset).toHaveBeenCalledWith('a1.jpg', true, false);
    expect(navigate).not.toHaveBeenCalled();
  });

  it('Shift-click extends the range and does not navigate', () => {
    component.onThumbClick(asset, click({ shiftKey: true }));

    expect(selectAsset).toHaveBeenCalledWith('a1.jpg', false, true);
    expect(navigate).not.toHaveBeenCalled();
  });

  it('a click in Select mode toggles membership and does not navigate', () => {
    isSelecting = true;
    component.onThumbClick(asset, click());

    expect(selectAsset).toHaveBeenCalledWith('a1.jpg', true, false);
    expect(navigate).not.toHaveBeenCalled();
  });

  it('a Shift-click in Select mode range-extends instead of toggling (#2976)', () => {
    isSelecting = true;
    component.onThumbClick(asset, click({ shiftKey: true, metaKey: true }));

    expect(selectAsset).toHaveBeenCalledWith('a1.jpg', false, true);
    expect(navigate).not.toHaveBeenCalled();
  });

  // ── Folder tiles (#2976) ─────────────────────────────────────────────────

  it('a plain folder-tile click drills into the folder', () => {
    component.onFolderTileClick(folder, click());

    expect(openSelfHostedSubfolder).toHaveBeenCalledWith('2026/France', 'lib:2026/France');
    expect(setFolderOpen).toHaveBeenCalledWith('lib:2026/France', true);
    expect(selectFolder).not.toHaveBeenCalled();
  });

  it('Cmd/Ctrl-click on a folder tile toggles its selection and does not navigate', () => {
    component.onFolderTileClick(folder, click({ ctrlKey: true }));

    expect(selectFolder).toHaveBeenCalledWith('lib:2026/France', true, false);
    expect(openSelfHostedSubfolder).not.toHaveBeenCalled();
  });

  it('Shift-click on a folder tile range-extends and does not navigate', () => {
    component.onFolderTileClick(folder, click({ shiftKey: true }));

    expect(selectFolder).toHaveBeenCalledWith('lib:2026/France', false, true);
    expect(openSelfHostedSubfolder).not.toHaveBeenCalled();
  });

  it('a folder-tile click in Select mode toggles membership and does not navigate', () => {
    isSelecting = true;
    component.onFolderTileClick(folder, click());

    expect(selectFolder).toHaveBeenCalledWith('lib:2026/France', true, false);
    expect(openSelfHostedSubfolder).not.toHaveBeenCalled();
  });
});

describe('AssetGridComponent — thumbnail size accessibility (#2462)', () => {
  let fixture: ComponentFixture<AssetGridComponent>;
  const thumbSize = signal(140);

  beforeEach(() => {
    thumbSize.set(140);
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe = vi.fn();
        disconnect = vi.fn();
      },
    );
    TestBed.configureTestingModule({
      providers: [
        {
          provide: LibraryStateService,
          useValue: {
            currentFolder: () => undefined,
            currentRegisteredFolder: () => undefined,
            selectedSourceLabel: () => undefined,
            thumbSize,
            sort: () => 'date',
            filter: () => 'all',
            selectedCount: () => 0,
            selectedTotalCount: () => 0,
            foldersInSelectedFolder: () => [],
            assetsInSelectedFolder: () => [],
            selectedAssetIds: () => new Set<AssetId>(),
            selectedFolderIds: () => new Set<string>(),
            backendLoading: () => false,
            backendError: () => undefined,
            selectedSourceId: () => undefined,
          },
        },
        { provide: Router, useValue: { navigate: vi.fn() } },
      ],
    });

    fixture = TestBed.createComponent(AssetGridComponent);
    fixture.detectChanges();
  });

  afterEach(() => vi.unstubAllGlobals());

  function slider(): HTMLInputElement {
    return fixture.nativeElement.querySelector('input[type="range"]') as HTMLInputElement;
  }

  it('names the range and exposes its current value and valid bounds', () => {
    expect(slider().getAttribute('aria-label')).toBe('Thumbnail size');
    expect(slider().getAttribute('aria-valuetext')).toBe('140 pixels');
    expect(slider().value).toBe('140');
    expect(slider().min).toBe('60');
    expect(slider().max).toBe('220');
  });

  it('keeps the semantic name and bounds stable when its value changes', () => {
    thumbSize.set(180);
    fixture.detectChanges();

    expect(slider().getAttribute('aria-label')).toBe('Thumbnail size');
    expect(slider().getAttribute('aria-valuetext')).toBe('180 pixels');
    expect(slider().value).toBe('180');
    expect(slider().min).toBe('60');
    expect(slider().max).toBe('220');
  });
});
