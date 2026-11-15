import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { of } from 'rxjs';
import { describe, it, expect, vi, beforeEach } from 'vitest';

import { AssetRenameService } from './asset-rename.service';
import { BunApiBackendService } from '../api/bun-api-backend.service';
import { LibraryStateService } from '../state/library-state.service';
import { FolderOccupancyService } from '../stack/folder-occupancy.service';
import { StackPairOpsService } from '../stack/stack-pair-ops.service';
import type { Asset } from '../models/asset';

const STACKED = {
  id: 'library:2026/IMG_0001.CR3',
  filename: 'IMG_0001.CR3',
  folderId: 'library:2026',
  rating: 0,
  flag: 'unflagged',
  colorLabel: null,
  thumbnailGradient: '',
  aspectRatio: 1.5,
  stack: {
    companion: { id: 'library:2026/IMG_0001.JPG', name: 'IMG_0001.JPG', ext: 'jpg', size: 1 },
  },
} as Asset;

describe('AssetRenameService stack pair ops (#5949)', () => {
  let renameAssetSpy: ReturnType<typeof vi.fn>;
  let renamePairSpy: ReturnType<typeof vi.fn>;
  let service: AssetRenameService;

  function setup(pairOutcome: unknown, supported = true) {
    renameAssetSpy = vi.fn();
    renamePairSpy = vi.fn().mockReturnValue(of(pairOutcome));
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        AssetRenameService,
        { provide: BunApiBackendService, useValue: { renameAsset: renameAssetSpy } },
        {
          provide: StackPairOpsService,
          useValue: { supported: () => of(supported), renamePair: renamePairSpy },
        },
        { provide: FolderOccupancyService, useValue: { occupiedNames: vi.fn() } },
        { provide: Router, useValue: { url: '/browse/library', navigate: vi.fn() } },
        {
          provide: LibraryStateService,
          useValue: {
            backend: 'self-hosted',
            focusedAssetId: () => null,
            renameAsset: vi.fn(),
            selectedSourceId: () => 'library:2026',
            refreshFolderListing: vi.fn(),
          },
        },
      ],
    });
    service = TestBed.inject(AssetRenameService);
  }

  beforeEach(() =>
    setup({
      kind: 'renamed',
      newAbsPath: '/x/Trip.CR3',
      newPath: '2026',
      newFilename: 'Trip.CR3',
      renamedOnCollision: false,
      extensionChanged: false,
      companion: { newAbsPath: '/x/Trip.JPG', newPath: '2026', newFilename: 'Trip.JPG' },
    }),
  );

  it('renames a stack in one pair request and never calls the single rename', () => {
    service.commit(STACKED, 'Trip.CR3');
    expect(renamePairSpy).toHaveBeenCalledTimes(1);
    expect(renamePairSpy).toHaveBeenCalledWith(
      STACKED.id,
      'library:2026/IMG_0001.JPG',
      'Trip.CR3',
      'skip',
      'skip',
    );
    expect(renameAssetSpy).not.toHaveBeenCalled();
    expect(service.busy()).toBe(false);
    expect(service.collision()).toBeNull();
  });

  it('a taken JPEG name prompts for the JPEG, and Replace resends the pair', () => {
    setup({ kind: 'skipped', reason: 'collision', collisionFilename: 'Trip.JPG' });
    service.commit(STACKED, 'Trip.CR3');
    expect(service.collision()).toMatchObject({
      assetId: STACKED.id,
      filename: 'Trip.JPG',
      companion: { filename: 'IMG_0001.JPG' },
    });

    renamePairSpy.mockReturnValue(
      of({ kind: 'renamed', newPath: '2026', newFilename: 'Trip.CR3' }),
    );
    service.resolveCollision(STACKED, 'replace');
    expect(renamePairSpy).toHaveBeenCalledTimes(2);
    expect(renamePairSpy).toHaveBeenLastCalledWith(
      STACKED.id,
      'library:2026/IMG_0001.JPG',
      'Trip.CR3',
      'skip',
      'replace',
    );
    expect(renameAssetSpy).not.toHaveBeenCalled();
  });

  it('an older server keeps the two-call path', () => {
    setup(null, false);
    renameAssetSpy.mockReturnValue(
      of({ kind: 'renamed', newPath: '2026', newFilename: 'Trip.CR3' }),
    );
    service.commit(STACKED, 'Trip.CR3');
    expect(renamePairSpy).not.toHaveBeenCalled();
    expect(renameAssetSpy).toHaveBeenCalled();
  });
});
