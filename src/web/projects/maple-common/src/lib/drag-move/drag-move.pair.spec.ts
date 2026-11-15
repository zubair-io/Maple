import { TestBed } from '@angular/core/testing';
import { of } from 'rxjs';
import { describe, it, expect, vi, beforeEach } from 'vitest';

import { DragMoveService } from './drag-move.service';
import { BunApiBackendService } from '../api/bun-api-backend.service';
import { FolderCrudService } from '../api/folder-crud.service';
import { LibraryStateService } from '../state/library-state.service';
import { FolderOccupancyService } from '../stack/folder-occupancy.service';
import { StackPairOpsService } from '../stack/stack-pair-ops.service';
import type { Asset } from '../models/asset';
import type { SidebarEntry } from '../models/folder';

const SOURCE_FOLDER_ID = 'library:2026';
const STACKED_RAW = {
  id: 'library:2026/IMG_0003.CR3',
  filename: 'IMG_0003.CR3',
  folderId: SOURCE_FOLDER_ID,
  stack: {
    companion: { id: 'library:2026/IMG_0003.JPG', name: 'IMG_0003.JPG', ext: 'jpg', size: 1 },
  },
} as Asset;
const TARGET_NODE: SidebarEntry = {
  kind: 'folder',
  id: 'library:2026/France',
  label: 'France',
  count: null,
};

describe('DragMoveService stack pair ops (#5949)', () => {
  let relocateAssetSpy: ReturnType<typeof vi.fn>;
  let relocatePairSpy: ReturnType<typeof vi.fn>;
  let service: DragMoveService;

  function setup(pairOutcome: unknown, supported = true) {
    relocateAssetSpy = vi.fn();
    relocatePairSpy = vi.fn().mockReturnValue(of(pairOutcome));
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        DragMoveService,
        { provide: BunApiBackendService, useValue: { relocateAsset: relocateAssetSpy } },
        { provide: FolderCrudService, useValue: { move: vi.fn() } },
        {
          provide: StackPairOpsService,
          useValue: { supported: () => of(supported), relocatePair: relocatePairSpy },
        },
        { provide: FolderOccupancyService, useValue: { occupiedNames: vi.fn() } },
        {
          provide: LibraryStateService,
          useValue: {
            backend: 'self-hosted',
            assets: () => [STACKED_RAW],
            gridFolders: () => [],
            registeredFolders: () => [],
            refreshFolderListing: vi.fn(),
            loadFolderTree: vi.fn(),
            clearSelection: vi.fn(),
          },
        },
      ],
    });
    service = TestBed.inject(DragMoveService);
  }

  beforeEach(() =>
    setup({
      kind: 'relocated',
      newAbsPath: '/x/France/IMG_0003.CR3',
      newPath: 'France',
      newFilename: 'IMG_0003.CR3',
      renamedOnCollision: false,
    }),
  );

  it('moves a stack in one pair request and counts one tile', () => {
    service.beginMove([STACKED_RAW.id], SOURCE_FOLDER_ID, TARGET_NODE, 'move');
    expect(relocatePairSpy).toHaveBeenCalledTimes(1);
    expect(relocatePairSpy).toHaveBeenCalledWith(
      STACKED_RAW.id,
      'library:2026/IMG_0003.JPG',
      'move',
      'skip',
      'skip',
      '2026/France',
      undefined,
    );
    expect(relocateAssetSpy).not.toHaveBeenCalled();
    expect(service.resultSummary()).toMatchObject({ total: 1, moved: 1, failed: [] });
  });

  it('a taken JPEG name prompts for the JPEG and Replace resends only the pair', () => {
    setup({ kind: 'skipped', reason: 'collision', collisionFilename: 'IMG_0003.JPG' });
    service.beginMove([STACKED_RAW.id], SOURCE_FOLDER_ID, TARGET_NODE, 'move');
    expect(service.collisionPrompt()).toMatchObject({
      filename: 'IMG_0003.JPG',
      companionOf: 'IMG_0003.CR3',
    });

    relocatePairSpy.mockReturnValue(
      of({ kind: 'relocated', newPath: 'France', newFilename: 'IMG_0003.CR3' }),
    );
    service.resolveCollision('replace');
    expect(relocatePairSpy).toHaveBeenCalledTimes(2);
    expect(relocatePairSpy).toHaveBeenLastCalledWith(
      STACKED_RAW.id,
      'library:2026/IMG_0003.JPG',
      'move',
      'skip',
      'replace',
      '2026/France',
      undefined,
    );
    expect(relocateAssetSpy).not.toHaveBeenCalled();
    expect(service.resultSummary()).toMatchObject({ total: 1, moved: 1 });
  });

  it('skipping the JPEG prompt on a pair server skips the whole tile', () => {
    setup({ kind: 'skipped', reason: 'collision', collisionFilename: 'IMG_0003.JPG' });
    service.beginMove([STACKED_RAW.id], SOURCE_FOLDER_ID, TARGET_NODE, 'move');
    service.resolveCollision('skip');
    expect(service.resultSummary()).toMatchObject({ total: 1, moved: 0, skipped: 1, failed: [] });
  });
});
