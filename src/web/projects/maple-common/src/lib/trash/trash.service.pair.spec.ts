import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { of } from 'rxjs';
import { describe, it, expect, vi, beforeEach } from 'vitest';

import { TrashService } from './trash.service';
import { TrashApiService } from '../api/trash-api.service';
import { BunApiBackendService } from '../api/bun-api-backend.service';
import { FolderCrudService } from '../api/folder-crud.service';
import { LibraryStateService } from '../state/library-state.service';
import { StackPairOpsService } from '../stack/stack-pair-ops.service';
import type { Asset } from '../models/asset';

const STACKED = {
  id: 'photos:IMG_0004.CR3',
  filename: 'IMG_0004.CR3',
  folderId: 'lib-1',
  rating: 0,
  flag: 'unflagged',
  colorLabel: null,
  thumbnailGradient: '',
  aspectRatio: 1.5,
  stack: { companion: { id: 'photos:IMG_0004.JPG', name: 'IMG_0004.JPG', ext: 'jpg', size: 1 } },
} as Asset;

const IDS: Record<string, string> = {
  'photos:IMG_0004.CR3': '507f1f77bcf86cd799439014',
  'photos:IMG_0004.JPG': '507f1f77bcf86cd799439015',
};

describe('TrashService stack pair ops (#5949)', () => {
  let deleteAssetSpy: ReturnType<typeof vi.fn>;
  let service: TrashService;

  function setup(supported: boolean) {
    deleteAssetSpy = vi.fn().mockReturnValue(of({ kind: 'ok' }));
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        TrashService,
        {
          provide: TrashApiService,
          useValue: {
            deleteAsset: deleteAssetSpy,
            listTrash: vi.fn().mockReturnValue(of({ items: [], nextCursor: null })),
          },
        },
        {
          provide: BunApiBackendService,
          useValue: {
            getAssetDetailsByAddress: (address: string) => of({ id: IDS[address] }),
          },
        },
        { provide: FolderCrudService, useValue: { trashFolder: vi.fn() } },
        { provide: StackPairOpsService, useValue: { supported: () => of(supported) } },
        {
          provide: LibraryStateService,
          useValue: {
            assets: () => [STACKED],
            refreshFolderListing: vi.fn(),
            currentRegisteredFolder: () => null,
            registeredFolders: () => [],
            loadFolderTree: vi.fn(),
            selectedAssetIds: signal(new Set<string>()),
            selectedFolderIds: signal(new Set<string>()),
          },
        },
      ],
    });
    service = TestBed.inject(TrashService);
  }

  beforeEach(() => setup(true));

  it('trashes a stack in one DELETE with companion when supported', async () => {
    service.trashAssets([STACKED.id], 'photos:');
    await vi.waitFor(() => expect(service.busy()).toBe(false));
    expect(deleteAssetSpy).toHaveBeenCalledTimes(1);
    expect(deleteAssetSpy).toHaveBeenCalledWith(
      IDS[STACKED.id],
      'trash',
      IDS['photos:IMG_0004.JPG'],
    );
    expect(service.resultSummary()).toMatchObject({ total: 1, trashed: 1, failed: [] });
  });

  it('keeps the two-call path on an older server', async () => {
    setup(false);
    service.trashAssets([STACKED.id], 'photos:');
    await vi.waitFor(() => expect(service.busy()).toBe(false));
    expect(deleteAssetSpy).toHaveBeenCalledTimes(2);
    expect(deleteAssetSpy).toHaveBeenNthCalledWith(1, IDS[STACKED.id], 'trash');
    expect(deleteAssetSpy).toHaveBeenNthCalledWith(2, IDS['photos:IMG_0004.JPG'], 'trash');
  });
});
