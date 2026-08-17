import { TestBed } from '@angular/core/testing';
import { of, throwError } from 'rxjs';
import { describe, it, expect, vi, beforeEach } from 'vitest';

import { TrashService } from './trash.service';
import { TrashApiService } from '../api/trash-api.service';
import { BunApiBackendService } from '../api/bun-api-backend.service';
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

// #2841 — a subfolder asset's `slug:relPath` address contains a `/` in the
// relPath segment (after the `:`), which is exactly the shape that used to
// 404 by not matching the server's `DELETE /api/assets/:id` route at all
// (a plain `slug:relPath` with no subfolder slash merely 400'd, since the
// unresolved address still isn't a valid Mongo ObjectId).
const ASSET_C_SUBFOLDER: Asset = {
  id: 'photos:2024/Trip/IMG_1.dng',
  filename: 'IMG_1.dng',
  folderId: LIBRARY_ID,
  rating: 0,
  flag: 'unflagged',
  colorLabel: null,
  thumbnailGradient: '',
  aspectRatio: 1.5,
};

/** `ASSET_A`/`ASSET_B`/`ASSET_C_SUBFOLDER`'s resolved Mongo ids, as
 * `getAssetDetailsByAddress` would return them — asserted against, never
 * equal to the address itself, so a regression that goes back to calling
 * `deleteAsset` with the raw address fails loudly. */
const MONGO_ID_BY_ADDRESS: Record<string, string> = {
  [ASSET_A.id]: '507f1f77bcf86cd799439011',
  [ASSET_B.id]: '507f1f77bcf86cd799439012',
  [ASSET_C_SUBFOLDER.id]: '507f1f77bcf86cd799439013',
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
  let getAssetDetailsByAddressSpy: ReturnType<typeof vi.fn>;
  let refreshFolderListingSpy: ReturnType<typeof vi.fn>;
  let service: TrashService;

  function setup() {
    listTrashSpy = vi.fn().mockReturnValue(of({ items: [], nextCursor: null }));
    restoreAssetSpy = vi.fn();
    restoreFolderSpy = vi.fn();
    deleteAssetSpy = vi.fn();
    refreshFolderListingSpy = vi.fn();
    // #2841 — resolves a grid selection's `slug:relPath` address to the
    // Mongo id `TrashApiService.deleteAsset` requires, mirroring what
    // `BunApiBackendService.getAssetDetailsByAddress` returns for real.
    getAssetDetailsByAddressSpy = vi.fn((address: string) =>
      of({ id: MONGO_ID_BY_ADDRESS[address] }),
    );

    const fakeApi = {
      listTrash: listTrashSpy,
      restoreAsset: restoreAssetSpy,
      restoreFolder: restoreFolderSpy,
      deleteAsset: deleteAssetSpy,
    };
    const fakeBunApi = {
      getAssetDetailsByAddress: getAssetDetailsByAddressSpy,
    };
    const fakeState = {
      assetsInSelectedFolder: () => [ASSET_A, ASSET_B, ASSET_C_SUBFOLDER],
      refreshFolderListing: refreshFolderListingSpy,
      currentRegisteredFolder: () => LIBRARY,
    };

    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        TrashService,
        { provide: TrashApiService, useValue: fakeApi },
        { provide: BunApiBackendService, useValue: fakeBunApi },
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
    it('sends every asset to Trash with intent=trash and reports a full success summary', async () => {
      deleteAssetSpy.mockReturnValue(of({ kind: 'ok' }));
      service.trashAssets([ASSET_A.id, ASSET_B.id], LIBRARY_ID);
      expect(service.busy()).toBe(true);
      await vi.waitFor(() => expect(service.busy()).toBe(false));
      expect(deleteAssetSpy).toHaveBeenCalledTimes(2);
      expect(deleteAssetSpy).toHaveBeenCalledWith(MONGO_ID_BY_ADDRESS[ASSET_A.id], 'trash');
      expect(deleteAssetSpy).toHaveBeenCalledWith(MONGO_ID_BY_ADDRESS[ASSET_B.id], 'trash');
      expect(service.resultSummary()).toEqual({ total: 2, trashed: 2, failed: [] });
      expect(refreshFolderListingSpy).toHaveBeenCalledWith(LIBRARY_ID);
    });

    // #2841 — this is the exact bug: `TrashApiService.deleteAsset` used to
    // be called with the raw `slug:relPath` address, unresolved. A root-
    // folder address (no `/` in the relPath) merely 400'd server-side
    // (`parseAssetId` -> `new ObjectId(id)` throws on a non-hex string); a
    // subfolder address additionally fails to even MATCH the
    // `/api/assets/:id` route once its `/` lands in the URL path, which is
    // why this asserts against the resolved Mongo id specifically, not just
    // "some id was passed."
    it('resolves a slug:relPath address (root and subfolder) to a Mongo id before calling deleteAsset', async () => {
      deleteAssetSpy.mockReturnValue(of({ kind: 'ok' }));
      service.trashAssets([ASSET_A.id, ASSET_C_SUBFOLDER.id], LIBRARY_ID);
      await vi.waitFor(() => expect(service.busy()).toBe(false));
      expect(getAssetDetailsByAddressSpy).toHaveBeenCalledWith(ASSET_A.id);
      expect(getAssetDetailsByAddressSpy).toHaveBeenCalledWith(ASSET_C_SUBFOLDER.id);
      expect(deleteAssetSpy).toHaveBeenCalledWith(MONGO_ID_BY_ADDRESS[ASSET_A.id], 'trash');
      expect(deleteAssetSpy).toHaveBeenCalledWith(
        MONGO_ID_BY_ADDRESS[ASSET_C_SUBFOLDER.id],
        'trash',
      );
      // Never the raw, unresolved address — that's exactly what the server
      // 400/404'd on.
      expect(deleteAssetSpy).not.toHaveBeenCalledWith(ASSET_A.id, 'trash');
      expect(deleteAssetSpy).not.toHaveBeenCalledWith(ASSET_C_SUBFOLDER.id, 'trash');
      expect(service.resultSummary()).toEqual({ total: 2, trashed: 2, failed: [] });
    });

    // A caller that already holds a genuine Mongo id (no `:` — the Trash
    // panel's own restore/delete flows are like this, though they call
    // `TrashApiService` directly rather than through `trashAssets`; this
    // proves `trashAssets` itself would round-trip one unchanged too, since
    // nothing about the resolve step should assume every id is an address)
    // must reach `deleteAsset` untouched, with no resolution round-trip.
    it('passes a genuine Mongo id straight through, with no resolution round-trip', async () => {
      const MONGO_ID = '507f1f77bcf86cd799439099';
      deleteAssetSpy.mockReturnValue(of({ kind: 'ok' }));
      service.trashAssets([MONGO_ID], LIBRARY_ID);
      await vi.waitFor(() => expect(service.busy()).toBe(false));
      expect(getAssetDetailsByAddressSpy).not.toHaveBeenCalled();
      expect(deleteAssetSpy).toHaveBeenCalledWith(MONGO_ID, 'trash');
      expect(service.resultSummary()).toEqual({ total: 1, trashed: 1, failed: [] });
    });

    it('reports partial failure without aborting the rest of the batch', async () => {
      deleteAssetSpy.mockImplementation((id: string) =>
        id === MONGO_ID_BY_ADDRESS[ASSET_A.id]
          ? throwError(() => new Error('locked'))
          : of({ kind: 'ok' }),
      );
      service.trashAssets([ASSET_A.id, ASSET_B.id], LIBRARY_ID);
      await vi.waitFor(() => expect(service.busy()).toBe(false));
      const summary = service.resultSummary();
      expect(summary?.trashed).toBe(1);
      expect(summary?.failed).toHaveLength(1);
      expect(summary?.failed[0].assetId).toBe(ASSET_A.id);
      expect(summary?.failed[0].alreadyTrashed).toBeUndefined();
    });

    // #2749 — a 409 (the caller's grid listing was stale: something else
    // already trashed this asset) is a benign, distinct outcome, never a
    // generic failure, and never a silent success either.
    it('reports a 409 conflict as alreadyTrashed, not a generic failure', async () => {
      deleteAssetSpy.mockImplementation((id: string) =>
        id === MONGO_ID_BY_ADDRESS[ASSET_A.id]
          ? of({ kind: 'conflict', state: 'trashed' })
          : of({ kind: 'ok' }),
      );
      service.trashAssets([ASSET_A.id, ASSET_B.id], LIBRARY_ID);
      await vi.waitFor(() => expect(service.busy()).toBe(false));
      const summary = service.resultSummary();
      expect(summary?.trashed).toBe(1);
      expect(summary?.failed).toHaveLength(1);
      expect(summary?.failed[0].assetId).toBe(ASSET_A.id);
      expect(summary?.failed[0].alreadyTrashed).toBe(true);
      expect(summary?.failed[0].reason).toMatch(/already in trash/i);
      // The stale listing this conflict revealed still gets refreshed.
      expect(refreshFolderListingSpy).toHaveBeenCalledWith(LIBRARY_ID);
    });

    it('is a no-op with an empty selection', () => {
      service.trashAssets([], LIBRARY_ID);
      expect(deleteAssetSpy).not.toHaveBeenCalled();
      expect(service.busy()).toBe(false);
    });

    it('dismissSummary clears the reported result', async () => {
      deleteAssetSpy.mockReturnValue(of({ kind: 'ok' }));
      service.trashAssets([ASSET_A.id], LIBRARY_ID);
      await vi.waitFor(() => expect(service.busy()).toBe(false));
      service.dismissSummary();
      expect(service.resultSummary()).toBeNull();
    });
  });
});
