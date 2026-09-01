// library-selection.service.spec.ts — grid selection semantics (#2976).
//
// Guards the two-set selection model: photos (`selectedAssetIds`) and grid
// folders (`selectedFolderIds`) are selected through the same gestures but
// tracked separately, a plain click on either kind replaces the ENTIRE
// selection, additive/range gestures extend one kind while leaving the
// other alone, and navigating to a different folder resets everything.

import { TestBed } from '@angular/core/testing';
import { describe, it, expect, beforeEach } from 'vitest';

import { LibrarySelection } from './library-selection.service';
import { LibraryStore } from './library-store.service';
import { LIBRARY_BACKEND } from '../api/library-backend.token';
import type { Asset, AssetId } from '../models/asset';
import type { GridFolderItem } from '../models/folder';

const SOURCE = 'lib:2026';

function makeAsset(name: string): Asset {
  return {
    id: `lib:2026/${name}` as AssetId,
    filename: name,
    folderId: SOURCE,
    rating: 0,
    flag: 'unflagged',
    colorLabel: null,
    thumbnailGradient: '',
    aspectRatio: 1.5,
  };
}

function makeFolder(name: string): GridFolderItem {
  return { id: `lib:2026/${name}`, name, parentSourceId: SOURCE };
}

const ASSETS = [makeAsset('a.dng'), makeAsset('b.dng'), makeAsset('c.dng'), makeAsset('d.dng')];
const FOLDERS = [makeFolder('Alpha'), makeFolder('Beta'), makeFolder('Gamma')];

describe('LibrarySelection — asset + folder selection (#2976)', () => {
  let selection: LibrarySelection;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [{ provide: LIBRARY_BACKEND, useValue: 'self-hosted' }],
    });
    const store = TestBed.inject(LibraryStore);
    store.assets.set(ASSETS);
    store.gridFolders.set(FOLDERS);
    selection = TestBed.inject(LibrarySelection);
    selection.selectedSourceId.set(SOURCE);
  });

  it('a plain asset click replaces the whole selection, folders included', () => {
    selection.selectFolder(FOLDERS[0]!.id);
    selection.selectAsset(ASSETS[0]!.id);

    expect(selection.selectedAssetIds()).toEqual(new Set([ASSETS[0]!.id]));
    expect(selection.selectedFolderIds()).toEqual(new Set());
  });

  it('a plain folder click replaces the whole selection, assets included', () => {
    selection.selectAsset(ASSETS[0]!.id);
    selection.selectFolder(FOLDERS[0]!.id);

    expect(selection.selectedFolderIds()).toEqual(new Set([FOLDERS[0]!.id]));
    expect(selection.selectedAssetIds()).toEqual(new Set());
  });

  it('additive gestures extend one kind and leave the other alone — mixed selections work', () => {
    selection.selectAsset(ASSETS[0]!.id);
    selection.selectFolder(FOLDERS[0]!.id, true);
    selection.selectAsset(ASSETS[1]!.id, true);

    expect(selection.selectedAssetIds()).toEqual(new Set([ASSETS[0]!.id, ASSETS[1]!.id]));
    expect(selection.selectedFolderIds()).toEqual(new Set([FOLDERS[0]!.id]));
    expect(selection.selectedTotalCount()).toBe(3);
  });

  it('additive folder click toggles membership off again', () => {
    selection.selectFolder(FOLDERS[0]!.id, true);
    selection.selectFolder(FOLDERS[0]!.id, true);
    expect(selection.selectedFolderIds()).toEqual(new Set());
  });

  it('shift-click range-selects folders between the anchor and the target', () => {
    selection.selectFolder(FOLDERS[0]!.id, true);
    selection.selectFolder(FOLDERS[2]!.id, false, true);

    expect(selection.selectedFolderIds()).toEqual(new Set(FOLDERS.map((f) => f.id)));
  });

  it('shift-click range-selects assets between the anchor and the target', () => {
    selection.selectAsset(ASSETS[1]!.id, true);
    selection.selectAsset(ASSETS[3]!.id, false, true);

    expect(selection.selectedAssetIds()).toEqual(
      new Set([ASSETS[1]!.id, ASSETS[2]!.id, ASSETS[3]!.id]),
    );
  });

  it('a range with no anchor falls back to selecting just the clicked item', () => {
    selection.selectFolder(FOLDERS[1]!.id, false, true);
    expect(selection.selectedFolderIds()).toEqual(new Set([FOLDERS[1]!.id]));
  });

  it('clearSelection empties both kinds', () => {
    selection.selectAsset(ASSETS[0]!.id);
    selection.selectFolder(FOLDERS[0]!.id, true);
    selection.clearSelection();

    expect(selection.selectedAssetIds()).toEqual(new Set());
    expect(selection.selectedFolderIds()).toEqual(new Set());
    expect(selection.selectedTotalCount()).toBe(0);
  });

  it('resetForSourceChange clears the sets AND the range anchors', () => {
    selection.selectAsset(ASSETS[0]!.id);
    selection.selectFolder(FOLDERS[0]!.id, true);
    selection.resetForSourceChange();

    expect(selection.selectedAssetIds()).toEqual(new Set());
    expect(selection.selectedFolderIds()).toEqual(new Set());
    expect(selection.focusedAssetId()).toBeNull();
    expect(selection.focusedFolderId()).toBeNull();
  });
});
