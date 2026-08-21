import { TestBed } from '@angular/core/testing';
import { of, throwError } from 'rxjs';
import { describe, it, expect, vi, beforeEach } from 'vitest';

import { DragMoveService } from './drag-move.service';
import { BunApiBackendService } from '../api/bun-api-backend.service';
import { FolderCrudService } from '../api/folder-crud.service';
import { LibraryStateService } from '../state/library-state.service';
import type { Asset } from '../models/asset';
import type { GridFolderItem, SidebarEntry } from '../models/folder';

const SOURCE_FOLDER_ID = 'library:2026';

const ASSET_A: Asset = {
  id: 'library:2026/IMG_0001.CR3',
  filename: 'IMG_0001.CR3',
  folderId: SOURCE_FOLDER_ID,
  rating: 0,
  flag: 'unflagged',
  colorLabel: null,
  thumbnailGradient: '',
  aspectRatio: 1.5,
};

const ASSET_B: Asset = {
  id: 'library:2026/IMG_0002.CR3',
  filename: 'IMG_0002.CR3',
  folderId: SOURCE_FOLDER_ID,
  rating: 0,
  flag: 'unflagged',
  colorLabel: null,
  thumbnailGradient: '',
  aspectRatio: 1.5,
};

const TARGET_NODE: SidebarEntry = {
  kind: 'folder',
  id: 'library:2026/France',
  label: 'France',
  count: null,
};

// Grid sub-folders under SOURCE_FOLDER_ID (#2976 folder move).
const FOLDER_TRIPS: GridFolderItem = {
  id: 'library:2026/Trips',
  name: 'Trips',
  parentSourceId: SOURCE_FOLDER_ID,
  aspectRatio: 1,
};

const REGISTERED_LIBRARY = {
  id: 'lib-mongo-id',
  path: '/photos',
  slug: 'library',
  label: 'Library',
  last_scan: null,
  file_count: 0,
  created_at: '',
};

const NON_FOLDER_NODE: SidebarEntry = {
  kind: 'smart',
  id: 'smart:picks',
  label: 'Picks',
  count: null,
};

describe('DragMoveService', () => {
  let relocateAssetSpy: ReturnType<typeof vi.fn>;
  let folderMoveSpy: ReturnType<typeof vi.fn>;
  let refreshFolderListingSpy: ReturnType<typeof vi.fn>;
  let loadFolderTreeSpy: ReturnType<typeof vi.fn>;
  let clearSelectionSpy: ReturnType<typeof vi.fn>;
  let service: DragMoveService;

  function setup(opts: { backend?: 'self-hosted' | 'hosted' } = {}) {
    relocateAssetSpy = vi.fn();
    folderMoveSpy = vi.fn();
    refreshFolderListingSpy = vi.fn();
    loadFolderTreeSpy = vi.fn();
    clearSelectionSpy = vi.fn();

    const fakeApi = { relocateAsset: relocateAssetSpy };
    const fakeFolderCrud = { move: folderMoveSpy };
    const fakeState = {
      backend: opts.backend ?? 'self-hosted',
      assets: () => [ASSET_A, ASSET_B],
      gridFolders: () => [FOLDER_TRIPS],
      registeredFolders: () => [REGISTERED_LIBRARY],
      refreshFolderListing: refreshFolderListingSpy,
      loadFolderTree: loadFolderTreeSpy,
      clearSelection: clearSelectionSpy,
    };

    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        DragMoveService,
        { provide: BunApiBackendService, useValue: fakeApi },
        { provide: FolderCrudService, useValue: fakeFolderCrud },
        { provide: LibraryStateService, useValue: fakeState },
      ],
    });
    service = TestBed.inject(DragMoveService);
  }

  beforeEach(() => setup());

  it('is unavailable on the Hosted backend', () => {
    setup({ backend: 'hosted' });
    expect(service.available()).toBe(false);
    expect(service.dropDisabledReason(TARGET_NODE, SOURCE_FOLDER_ID)).toMatch(/self hosted/i);
  });

  it('rejects a non-folder drop target', () => {
    expect(service.dropDisabledReason(NON_FOLDER_NODE, SOURCE_FOLDER_ID)).not.toBeNull();
  });

  it('rejects a legacy fs: node', () => {
    expect(
      service.dropDisabledReason({ ...TARGET_NODE, id: 'fs:/Users/x/Photos' }, SOURCE_FOLDER_ID),
    ).not.toBeNull();
  });

  it('rejects dropping onto the assets own current folder', () => {
    expect(
      service.dropDisabledReason({ ...TARGET_NODE, id: SOURCE_FOLDER_ID }, SOURCE_FOLDER_ID),
    ).not.toBeNull();
  });

  it('accepts a normal, different folder target', () => {
    expect(service.dropDisabledReason(TARGET_NODE, SOURCE_FOLDER_ID)).toBeNull();
  });

  it('rejects a target in a different registered library — relocateAsset resolves destinationPath against the SOURCE library root, so a cross-library drop would silently land inside the wrong library (confirmed live, #2644 review)', () => {
    const otherLibraryNode: SidebarEntry = {
      kind: 'folder',
      id: 'other-lib:',
      label: 'Other Library',
      count: null,
    };
    expect(service.dropDisabledReason(otherLibraryNode, SOURCE_FOLDER_ID)).toMatch(
      /different libraries/i,
    );
  });

  it('beginMove is a no-op for a cross-library target', () => {
    const otherLibraryNode: SidebarEntry = {
      kind: 'folder',
      id: 'other-lib:',
      label: 'Other Library',
      count: null,
    };
    service.beginMove([ASSET_A.id], SOURCE_FOLDER_ID, otherLibraryNode, 'move');
    expect(relocateAssetSpy).not.toHaveBeenCalled();
  });

  it('beginMove is a no-op for an invalid target', () => {
    service.beginMove([ASSET_A.id], SOURCE_FOLDER_ID, NON_FOLDER_NODE, 'move');
    expect(relocateAssetSpy).not.toHaveBeenCalled();
    expect(service.busy()).toBe(false);
  });

  it('a single successful move calls relocateAsset with destination path and refreshes both folders', () => {
    relocateAssetSpy.mockReturnValue(
      of({
        kind: 'relocated',
        newAbsPath: '/lib/France/IMG_0001.CR3',
        newPath: 'France',
        newFilename: 'IMG_0001.CR3',
        renamedOnCollision: false,
      }),
    );
    service.beginMove([ASSET_A.id], SOURCE_FOLDER_ID, TARGET_NODE, 'move');

    expect(relocateAssetSpy).toHaveBeenCalledWith(ASSET_A.id, 'move', 'skip', '2026/France');
    expect(service.busy()).toBe(false);
    expect(service.resultSummary()).toEqual({
      mode: 'move',
      targetLabel: 'France',
      total: 1,
      moved: 1,
      skipped: 0,
      failed: [],
    });
    expect(refreshFolderListingSpy).toHaveBeenCalledWith(SOURCE_FOLDER_ID);
    expect(refreshFolderListingSpy).toHaveBeenCalledWith(TARGET_NODE.id);
    expect(loadFolderTreeSpy).toHaveBeenCalled();
    expect(clearSelectionSpy).toHaveBeenCalled();
  });

  it('copy mode does not clear the selection (originals stay put)', () => {
    relocateAssetSpy.mockReturnValue(
      of({
        kind: 'relocated',
        newAbsPath: '/lib/France/IMG_0001.CR3',
        newPath: 'France',
        newFilename: 'IMG_0001.CR3',
        renamedOnCollision: false,
      }),
    );
    service.beginMove([ASSET_A.id], SOURCE_FOLDER_ID, TARGET_NODE, 'copy');
    expect(clearSelectionSpy).not.toHaveBeenCalled();
  });

  it('a collision pauses the queue with a prompt instead of overwriting', () => {
    relocateAssetSpy.mockReturnValue(of({ kind: 'skipped', reason: 'collision' }));
    service.beginMove([ASSET_A.id], SOURCE_FOLDER_ID, TARGET_NODE, 'move');

    expect(service.collisionPrompt()).toEqual({ filename: ASSET_A.filename });
    expect(service.busy()).toBe(true);
    expect(service.resultSummary()).toBeNull();
  });

  it('resolveCollision(replace) re-issues with collision:replace and continues the queue', () => {
    relocateAssetSpy.mockReturnValueOnce(of({ kind: 'skipped', reason: 'collision' }));
    service.beginMove([ASSET_A.id], SOURCE_FOLDER_ID, TARGET_NODE, 'move');

    relocateAssetSpy.mockReturnValueOnce(
      of({
        kind: 'relocated',
        newAbsPath: '/x',
        newPath: 'France',
        newFilename: 'IMG_0001.CR3',
        renamedOnCollision: false,
      }),
    );
    service.resolveCollision('replace');

    expect(relocateAssetSpy).toHaveBeenLastCalledWith(ASSET_A.id, 'move', 'replace', '2026/France');
    expect(service.collisionPrompt()).toBeNull();
    expect(service.resultSummary()?.moved).toBe(1);
  });

  it('resolveCollision(skip) counts the item as skipped, not failed, and continues', () => {
    relocateAssetSpy.mockReturnValueOnce(of({ kind: 'skipped', reason: 'collision' }));
    service.beginMove([ASSET_A.id, ASSET_B.id], SOURCE_FOLDER_ID, TARGET_NODE, 'move');

    relocateAssetSpy.mockReturnValueOnce(
      of({
        kind: 'relocated',
        newAbsPath: '/x',
        newPath: 'France',
        newFilename: 'IMG_0002.CR3',
        renamedOnCollision: false,
      }),
    );
    service.resolveCollision('skip');

    expect(service.resultSummary()).toEqual({
      mode: 'move',
      targetLabel: 'France',
      total: 2,
      moved: 1,
      skipped: 1,
      failed: [],
    });
  });

  it('a non-collision failure is recorded and the queue continues (partial failure, no rollback)', () => {
    relocateAssetSpy
      .mockReturnValueOnce(throwError(() => ({ error: { error: 'disk full' } })))
      .mockReturnValueOnce(
        of({
          kind: 'relocated',
          newAbsPath: '/x',
          newPath: 'France',
          newFilename: 'IMG_0002.CR3',
          renamedOnCollision: false,
        }),
      );
    service.beginMove([ASSET_A.id, ASSET_B.id], SOURCE_FOLDER_ID, TARGET_NODE, 'move');

    const summary = service.resultSummary();
    expect(summary?.moved).toBe(1);
    expect(summary?.failed).toEqual([
      { assetId: ASSET_A.id, filename: ASSET_A.filename, reason: 'disk full' },
    ]);
  });

  it('a multi-select drop processes every asset sequentially, one request at a time', () => {
    relocateAssetSpy.mockReturnValue(
      of({
        kind: 'relocated',
        newAbsPath: '/x',
        newPath: 'France',
        newFilename: 'x',
        renamedOnCollision: false,
      }),
    );
    service.beginMove([ASSET_A.id, ASSET_B.id], SOURCE_FOLDER_ID, TARGET_NODE, 'move');

    expect(relocateAssetSpy).toHaveBeenCalledTimes(2);
    expect(service.resultSummary()?.moved).toBe(2);
  });

  it('beginMove ignores a second call while the queue is still busy', () => {
    relocateAssetSpy.mockReturnValue(of({ kind: 'skipped', reason: 'collision' }));
    service.beginMove([ASSET_A.id], SOURCE_FOLDER_ID, TARGET_NODE, 'move');
    expect(service.busy()).toBe(true);

    service.beginMove([ASSET_B.id], SOURCE_FOLDER_ID, TARGET_NODE, 'move');
    // Still the FIRST asset's collision prompt — the second call was a no-op.
    expect(service.collisionPrompt()).toEqual({ filename: ASSET_A.filename });
  });

  // ── Folder move (#2976) ──────────────────────────────────────────────────

  it('moves a selected grid folder via POST /folders/:id/move into a child of the target', () => {
    folderMoveSpy.mockReturnValue(
      of({ kind: 'ok', result: { abs_path: '/photos/2026/France/Trips' } }),
    );
    service.beginMove([], SOURCE_FOLDER_ID, TARGET_NODE, 'move', [FOLDER_TRIPS.id]);

    expect(folderMoveSpy).toHaveBeenCalledWith('lib-mongo-id', '2026/Trips', '2026/France/Trips');
    expect(service.resultSummary()).toEqual({
      mode: 'move',
      targetLabel: 'France',
      total: 1,
      moved: 1,
      skipped: 0,
      failed: [],
    });
    expect(clearSelectionSpy).toHaveBeenCalled();
    expect(loadFolderTreeSpy).toHaveBeenCalled();
  });

  it('a folder-move 409 collision is a per-item failure, not a Skip/Replace prompt', () => {
    folderMoveSpy.mockReturnValue(of({ kind: 'collision' }));
    service.beginMove([], SOURCE_FOLDER_ID, TARGET_NODE, 'move', [FOLDER_TRIPS.id]);

    expect(service.collisionPrompt()).toBeNull();
    const summary = service.resultSummary();
    expect(summary?.moved).toBe(0);
    expect(summary?.failed).toEqual([
      {
        assetId: FOLDER_TRIPS.id,
        filename: 'Trips',
        reason: '"Trips" already exists in the destination.',
      },
    ]);
  });

  it('refuses to move a folder into itself or its own descendant', () => {
    const insideTrips: SidebarEntry = {
      kind: 'folder',
      id: 'library:2026/Trips/Japan',
      label: 'Japan',
      count: null,
    };
    service.beginMove([], SOURCE_FOLDER_ID, insideTrips, 'move', [FOLDER_TRIPS.id]);

    expect(folderMoveSpy).not.toHaveBeenCalled();
    expect(service.resultSummary()?.failed).toEqual([
      { assetId: FOLDER_TRIPS.id, filename: 'Trips', reason: "Can't move a folder into itself." },
    ]);
  });

  it('copy mode ignores folders — no recursive-copy server primitive', () => {
    service.beginMove([], SOURCE_FOLDER_ID, TARGET_NODE, 'copy', [FOLDER_TRIPS.id]);

    expect(folderMoveSpy).not.toHaveBeenCalled();
    expect(service.busy()).toBe(false);
    expect(service.resultSummary()).toBeNull();
  });

  it('a mixed drop relocates the assets and moves the folders in one queue', () => {
    relocateAssetSpy.mockReturnValue(
      of({
        kind: 'relocated',
        newAbsPath: '/x',
        newPath: 'France',
        newFilename: 'IMG_0001.CR3',
        renamedOnCollision: false,
      }),
    );
    folderMoveSpy.mockReturnValue(of({ kind: 'ok', result: { abs_path: '/x/Trips' } }));
    service.beginMove([ASSET_A.id], SOURCE_FOLDER_ID, TARGET_NODE, 'move', [FOLDER_TRIPS.id]);

    expect(relocateAssetSpy).toHaveBeenCalledTimes(1);
    expect(folderMoveSpy).toHaveBeenCalledTimes(1);
    expect(service.resultSummary()).toMatchObject({ total: 2, moved: 2, failed: [] });
  });

  it('dismissSummary clears the completed-drop summary banner', () => {
    relocateAssetSpy.mockReturnValue(
      of({
        kind: 'relocated',
        newAbsPath: '/x',
        newPath: 'France',
        newFilename: 'x',
        renamedOnCollision: false,
      }),
    );
    service.beginMove([ASSET_A.id], SOURCE_FOLDER_ID, TARGET_NODE, 'move');
    expect(service.resultSummary()).not.toBeNull();

    service.dismissSummary();
    expect(service.resultSummary()).toBeNull();
  });
});
