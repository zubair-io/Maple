import { TestBed } from '@angular/core/testing';
import { of, throwError } from 'rxjs';
import { describe, it, expect, vi, beforeEach } from 'vitest';

import { TrashService } from './trash.service';
import { TrashApiService } from '../api/trash-api.service';
import { LibraryStateService } from '../state/library-state.service';
import type { Asset } from '../models/asset';
import type { ApiFolder } from '../workspace/server-library-io';

const LIBRARY_ID = 'lib-1';

const ASSET_A: Asset = {
  id: 'photos:IMG_0001.CR3',
  filename: 'IMG_0001.CR3',
  folderId: LIBRARY_ID,
  rating: 0,
  flag: 'unflagged',
  colorLabel: null,
  thumbnailGradient: '',
  aspectRatio: 1.5,
};

const ASSET_B: Asset = {
  id: 'photos:IMG_0002.CR3',
  filename: 'IMG_0002.CR3',
  folderId: LIBRARY_ID,
  rating: 0,
  flag: 'unflagged',
  colorLabel: null,
  thumbnailGradient: '',
  aspectRatio: 1.5,
};

const LIBRARY: ApiFolder = {
  id: LIBRARY_ID,
  path: '/photos',
  slug: 'photos',
  label: 'Photos',
  last_scan: null,
  file_count: 2,
  created_at: '',
};

describe('TrashService', () => {
  let listTrashSpy: ReturnType<typeof vi.fn>;
  let restoreAssetSpy: ReturnType<typeof vi.fn>;
  let restoreFolderSpy: ReturnType<typeof vi.fn>;
  let deleteAssetSpy: ReturnType<typeof vi.fn>;
  let refreshFolderListingSpy: ReturnType<typeof vi.fn>;
  let service: TrashService;

  function setup() {
    listTrashSpy = vi.fn().mockReturnValue(of({ items: [], nextCursor: null }));
    restoreAssetSpy = vi.fn();
    restoreFolderSpy = vi.fn();
    deleteAssetSpy = vi.fn();
    refreshFolderListingSpy = vi.fn();

    const fakeApi = {
      listTrash: listTrashSpy,
      restoreAsset: restoreAssetSpy,
      restoreFolder: restoreFolderSpy,
      deleteAsset: deleteAssetSpy,
    };
    const fakeState = {
      assetsInSelectedFolder: () => [ASSET_A, ASSET_B],
      refreshFolderListing: refreshFolderListingSpy,
      currentRegisteredFolder: () => LIBRARY,
    };

    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        TrashService,
        { provide: TrashApiService, useValue: fakeApi },
        { provide: LibraryStateService, useValue: fakeState },
      ],
    });
    service = TestBed.inject(TrashService);
  }

  beforeEach(() => setup());

  it('is always available (only ever provided Self-Hosted)', () => {
    expect(service.available()).toBe(true);
  });

  describe('ensureCountLoaded', () => {
    it('fetches and caches a library count', async () => {
      listTrashSpy.mockReturnValue(of({ items: [{}, {}], nextCursor: null }));
      service.ensureCountLoaded(LIBRARY_ID);
      await Promise.resolve();
      expect(service.countByLibrary()[LIBRARY_ID]).toEqual({ count: 2, capped: false });
    });

    it('marks the count capped when a next page remains', async () => {
      listTrashSpy.mockReturnValue(of({ items: [{}], nextCursor: 'cursor-1' }));
      service.ensureCountLoaded(LIBRARY_ID);
      await Promise.resolve();
      expect(service.countByLibrary()[LIBRARY_ID]).toEqual({ count: 1, capped: true });
    });

    it('does not re-fetch an already-loaded library', async () => {
      listTrashSpy.mockReturnValue(of({ items: [], nextCursor: null }));
      service.ensureCountLoaded(LIBRARY_ID);
      await Promise.resolve();
      service.ensureCountLoaded(LIBRARY_ID);
      expect(listTrashSpy).toHaveBeenCalledTimes(1);
    });

    it('leaves the library uncounted on a fetch error', async () => {
      listTrashSpy.mockReturnValue(throwError(() => new Error('boom')));
      service.ensureCountLoaded(LIBRARY_ID);
      await Promise.resolve();
      expect(service.countByLibrary()[LIBRARY_ID]).toBeUndefined();
    });
  });

  describe('panel open/close', () => {
    it('open sets the panel state', () => {
      service.open(LIBRARY_ID, 'Photos');
      expect(service.panelOpen()).toBe(true);
      expect(service.panelLibraryId()).toBe(LIBRARY_ID);
      expect(service.panelLibraryLabel()).toBe('Photos');
    });

    it('closePanel clears it', () => {
      service.open(LIBRARY_ID, 'Photos');
      service.closePanel();
      expect(service.panelOpen()).toBe(false);
      expect(service.panelLibraryId()).toBeNull();
    });
  });

  describe('trashAssets', () => {
    it('sends every asset to Trash and reports a full success summary', async () => {
      deleteAssetSpy.mockReturnValue(of(undefined));
      service.trashAssets([ASSET_A.id, ASSET_B.id], LIBRARY_ID);
      expect(service.busy()).toBe(true);
      await vi.waitFor(() => expect(service.busy()).toBe(false));
      expect(deleteAssetSpy).toHaveBeenCalledTimes(2);
      expect(service.resultSummary()).toEqual({ total: 2, trashed: 2, failed: [] });
      expect(refreshFolderListingSpy).toHaveBeenCalledWith(LIBRARY_ID);
    });

    it('reports partial failure without aborting the rest of the batch', async () => {
      deleteAssetSpy.mockImplementation((id: string) =>
        id === ASSET_A.id ? throwError(() => new Error('locked')) : of(undefined),
      );
      service.trashAssets([ASSET_A.id, ASSET_B.id], LIBRARY_ID);
      await vi.waitFor(() => expect(service.busy()).toBe(false));
      const summary = service.resultSummary();
      expect(summary?.trashed).toBe(1);
      expect(summary?.failed).toHaveLength(1);
      expect(summary?.failed[0].assetId).toBe(ASSET_A.id);
    });

    it('is a no-op with an empty selection', () => {
      service.trashAssets([], LIBRARY_ID);
      expect(deleteAssetSpy).not.toHaveBeenCalled();
      expect(service.busy()).toBe(false);
    });

    it('dismissSummary clears the reported result', async () => {
      deleteAssetSpy.mockReturnValue(of(undefined));
      service.trashAssets([ASSET_A.id], LIBRARY_ID);
      await vi.waitFor(() => expect(service.busy()).toBe(false));
      service.dismissSummary();
      expect(service.resultSummary()).toBeNull();
    });
  });
});
