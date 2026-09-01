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
import { TRASH_CAPABILITY } from '../../trash/trash-capability';
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

describe('AssetGridComponent — folder section rows (#3099)', () => {
  function build(folders: { id: string; name: string; parentSourceId: string }[], assets: Asset[]) {
    TestBed.configureTestingModule({
      providers: [
        {
          provide: LibraryStateService,
          useValue: {
            thumbSize: () => 140,
            foldersInSelectedFolder: () => folders,
            assetsInSelectedFolder: () => assets,
          },
        },
        { provide: Router, useValue: { navigate: vi.fn() } },
      ],
    });
    return TestBed.runInInjectionContext(() => new AssetGridComponent());
  }

  const folders = ['A', 'B', 'C', 'D', 'E'].map((n) => ({
    id: `lib:${n}`,
    name: n,
    parentSourceId: 'lib',
  }));
  const landscape = (id: string): Asset => ({ ...makeAsset(id), aspectRatio: 3 / 2 });

  it('packs folders into fixed 180×64 rows ahead of the justified image rows', () => {
    const component = build(folders, [landscape('a1'), landscape('a2')]);
    const rows = component.gridRows();

    // Default 800px container → four 180px tiles (+4px gaps) per folder row.
    expect(rows.map((r) => r.kind)).toEqual(['folders', 'folders', 'images']);
    expect(rows[0].items).toHaveLength(4);
    expect(rows[1].items).toHaveLength(1);
    expect(rows[0].height).toBe(64);
    expect(rows[0].gap).toBe(4);
    expect(component.itemWidth(rows[0].items[0], rows[0])).toBe(180);

    // Folder rows sit 4px apart; the last one carries the 12px section gap
    // before the photos.
    expect(rows[0].spacingBelow).toBe(4);
    expect(rows[1].spacingBelow).toBe(12);

    // Images never share a row with folders.
    expect(rows[2].items.every((i) => i.kind === 'image')).toBe(true);
    expect(rows[2].gap).toBe(3);
    expect(component.itemWidth(rows[2].items[0], rows[2])).toBeCloseTo(1.5 * rows[2].height);
  });

  it('emits no folder rows for a directory without subfolders', () => {
    const component = build([], [landscape('a1')]);
    expect(component.gridRows().map((r) => r.kind)).toEqual(['images']);
  });
});

describe('AssetGridComponent — Delete/Backspace sends selection to Trash (#2752)', () => {
  let trashAssets: ReturnType<typeof vi.fn>;
  let available: boolean;
  let busy: boolean;
  let selectedTotalCount: number;
  let selectedSourceId: string | undefined;
  let selectedAssetIds: Set<AssetId>;
  let selectedFolderIds: Set<string>;
  let component: AssetGridComponent;

  function keydown(key: string, target?: HTMLElement): KeyboardEvent {
    return {
      key,
      target: target ?? document.body,
      preventDefault: vi.fn(),
    } as unknown as KeyboardEvent;
  }

  beforeEach(() => {
    trashAssets = vi.fn();
    available = true;
    busy = false;
    selectedTotalCount = 1;
    selectedSourceId = 'lib:2026';
    selectedAssetIds = new Set(['a1' as AssetId]);
    selectedFolderIds = new Set<string>();

    TestBed.configureTestingModule({
      providers: [
        {
          provide: LibraryStateService,
          useValue: {
            selectedTotalCount: () => selectedTotalCount,
            selectedSourceId: () => selectedSourceId,
            selectedAssetIds: () => selectedAssetIds,
            selectedFolderIds: () => selectedFolderIds,
          },
        },
        { provide: Router, useValue: { navigate: vi.fn() } },
        {
          provide: TRASH_CAPABILITY,
          useValue: {
            available: () => available,
            busy: () => busy,
            trashAssets,
          },
        },
      ],
    });

    component = TestBed.runInInjectionContext(() => new AssetGridComponent());
  });

  it('sends the selection to Trash on Delete', () => {
    component.onGridKeydown(keydown('Delete'));
    expect(trashAssets).toHaveBeenCalledWith(['a1'], 'lib:2026', []);
  });

  it('sends the selection to Trash on Backspace', () => {
    component.onGridKeydown(keydown('Backspace'));
    expect(trashAssets).toHaveBeenCalledWith(['a1'], 'lib:2026', []);
  });

  it('sends folder ids alongside asset ids (#2976)', () => {
    selectedFolderIds = new Set(['lib:2026/France']);
    component.onGridKeydown(keydown('Delete'));
    expect(trashAssets).toHaveBeenCalledWith(['a1'], 'lib:2026', ['lib:2026/France']);
  });

  it('calls preventDefault when it fires', () => {
    const e = keydown('Delete');
    component.onGridKeydown(e);
    expect(e.preventDefault).toHaveBeenCalled();
  });

  it('ignores every other key', () => {
    component.onGridKeydown(keydown('a'));
    expect(trashAssets).not.toHaveBeenCalled();
  });

  it('does nothing while focus is in a text input', () => {
    component.onGridKeydown(keydown('Delete', document.createElement('input')));
    expect(trashAssets).not.toHaveBeenCalled();
  });

  it('does nothing while focus is in a textarea', () => {
    component.onGridKeydown(keydown('Delete', document.createElement('textarea')));
    expect(trashAssets).not.toHaveBeenCalled();
  });

  it('does nothing while focus is in a contenteditable element', () => {
    // jsdom doesn't compute `isContentEditable` from the `contenteditable`
    // attribute the way real browsers do, so assert directly against the
    // property the handler reads.
    const editable = { isContentEditable: true } as unknown as HTMLElement;
    component.onGridKeydown(keydown('Delete', editable));
    expect(trashAssets).not.toHaveBeenCalled();
  });

  it('does nothing while a modal dialog is open (batch rename / move-to / metadata / trash confirm)', () => {
    const dialog = document.createElement('div');
    dialog.setAttribute('aria-modal', 'true');
    document.body.appendChild(dialog);
    try {
      component.onGridKeydown(keydown('Delete'));
      expect(trashAssets).not.toHaveBeenCalled();
    } finally {
      dialog.remove();
    }
  });

  it('does nothing when Trash is not wired up (Hosted)', () => {
    available = false;
    component.onGridKeydown(keydown('Delete'));
    expect(trashAssets).not.toHaveBeenCalled();
  });

  it('does nothing while a previous batch is still in flight', () => {
    busy = true;
    component.onGridKeydown(keydown('Delete'));
    expect(trashAssets).not.toHaveBeenCalled();
  });

  it('does nothing when the selection is empty', () => {
    selectedTotalCount = 0;
    component.onGridKeydown(keydown('Delete'));
    expect(trashAssets).not.toHaveBeenCalled();
  });

  it('does nothing when no source folder is selected', () => {
    selectedSourceId = undefined;
    component.onGridKeydown(keydown('Delete'));
    expect(trashAssets).not.toHaveBeenCalled();
  });
});
