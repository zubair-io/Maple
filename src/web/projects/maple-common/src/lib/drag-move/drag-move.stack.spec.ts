// DragMoveService with RAW+JPEG stacks (#5846 review): a pair is one queue
// item and one tile, but two relocates; the JPEG never inherits the RAW's
// collision choice.

import { TestBed } from '@angular/core/testing';
import { of, throwError } from 'rxjs';
import { describe, it, expect, vi, beforeEach } from 'vitest';

import { DragMoveService } from './drag-move.service';
import { BunApiBackendService } from '../api/bun-api-backend.service';
import { FolderCrudService } from '../api/folder-crud.service';
import { LibraryStateService } from '../state/library-state.service';
import { FolderOccupancyService } from '../stack/folder-occupancy.service';
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

let relocateAssetSpy: ReturnType<typeof vi.fn>;
let occupiedSpy: ReturnType<typeof vi.fn>;
let service: DragMoveService;

beforeEach(() => {
  relocateAssetSpy = vi.fn();
  occupiedSpy = vi.fn();
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      DragMoveService,
      { provide: BunApiBackendService, useValue: { relocateAsset: relocateAssetSpy } },
      { provide: FolderCrudService, useValue: { move: vi.fn() } },
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
      { provide: FolderOccupancyService, useValue: { occupiedNames: occupiedSpy } },
    ],
  });
  service = TestBed.inject(DragMoveService);
});

describe('RAW+JPEG stack (#5846): one tile, two relocates', () => {
  const relocated = (newFilename: string) =>
    of({
      kind: 'relocated',
      newAbsPath: `/lib/2026/France/${newFilename}`,
      newPath: '2026/France',
      newFilename,
      renamedOnCollision: false,
    });
  const collision = () => of({ kind: 'skipped', reason: 'collision' });

  it('moves the JPEG after its RAW, to the RAW’s resulting stem, and counts one tile', () => {
    relocateAssetSpy
      .mockReturnValueOnce(relocated('IMG_0003.CR3'))
      .mockReturnValueOnce(relocated('IMG_0003.JPG'));
    service.beginMove([STACKED_RAW.id], SOURCE_FOLDER_ID, TARGET_NODE, 'move');

    expect(relocateAssetSpy.mock.calls).toEqual([
      ['library:2026/IMG_0003.CR3', 'move', 'skip', '2026/France'],
      ['library:2026/IMG_0003.JPG', 'move', 'skip', '2026/France', 'IMG_0003.JPG'],
    ]);
    expect(service.resultSummary()).toMatchObject({ total: 1, moved: 1, skipped: 0 });
  });

  it('leaves the JPEG where it is when the user skips the RAW', () => {
    relocateAssetSpy.mockReturnValueOnce(collision());
    service.beginMove([STACKED_RAW.id], SOURCE_FOLDER_ID, TARGET_NODE, 'move');
    service.resolveCollision('skip');

    expect(relocateAssetSpy).toHaveBeenCalledTimes(1);
    expect(service.resultSummary()).toMatchObject({ total: 1, moved: 0, skipped: 1 });
  });

  it('leaves the JPEG where it is when the RAW fails', () => {
    relocateAssetSpy.mockReturnValueOnce(throwError(() => new Error('disk full')));
    service.beginMove([STACKED_RAW.id], SOURCE_FOLDER_ID, TARGET_NODE, 'move');

    expect(relocateAssetSpy).toHaveBeenCalledTimes(1);
    expect(service.resultSummary()?.failed).toHaveLength(1);
  });

  it('never sends Replace chosen for the RAW to the JPEG: the JPEG is prompted by name', () => {
    relocateAssetSpy
      .mockReturnValueOnce(collision())
      .mockReturnValueOnce(relocated('IMG_0003.CR3'))
      .mockReturnValueOnce(collision());
    service.beginMove([STACKED_RAW.id], SOURCE_FOLDER_ID, TARGET_NODE, 'move');
    service.resolveCollision('replace');

    expect(relocateAssetSpy.mock.calls[2]).toEqual([
      'library:2026/IMG_0003.JPG',
      'move',
      'skip',
      '2026/France',
      'IMG_0003.JPG',
    ]);
    expect(service.collisionPrompt()).toEqual({
      filename: 'IMG_0003.JPG',
      companionOf: 'IMG_0003.CR3',
    });

    service.resolveCollision('keep-both');
    expect(relocateAssetSpy).toHaveBeenCalledTimes(3);
    service.resolveCollision('skip');
    const summary = service.resultSummary();
    expect(summary).toMatchObject({ total: 1, moved: 0, skipped: 0 });
    expect(summary?.failed[0]?.reason).toContain('IMG_0003.CR3 was moved, but its JPEG');
  });

  it('replaces the JPEG target only when the user chooses Replace on the JPEG’s prompt', () => {
    relocateAssetSpy
      .mockReturnValueOnce(relocated('IMG_0003.CR3'))
      .mockReturnValueOnce(collision())
      .mockReturnValueOnce(relocated('IMG_0003.JPG'));
    service.beginMove([STACKED_RAW.id], SOURCE_FOLDER_ID, TARGET_NODE, 'move');
    service.resolveCollision('replace');

    expect(relocateAssetSpy).toHaveBeenLastCalledWith(
      'library:2026/IMG_0003.JPG',
      'move',
      'replace',
      '2026/France',
      'IMG_0003.JPG',
    );
    expect(service.resultSummary()).toMatchObject({ total: 1, moved: 1 });
  });

  it('Keep Both picks one stem free for the RAW, the JPEG and their sidecar', () => {
    occupiedSpy.mockReturnValue(
      of(new Set(['img_0003.cr3', 'img_0003.jpg', 'img_0003.1.jpg', 'img_0003.2.xmp'])),
    );
    relocateAssetSpy
      .mockReturnValueOnce(collision())
      .mockImplementation((_id: string, _m: string, _c: string, _p: string, name: string) =>
        relocated(name),
      );
    service.beginMove([STACKED_RAW.id], SOURCE_FOLDER_ID, TARGET_NODE, 'move');
    service.resolveCollision('keep-both');

    expect(occupiedSpy).toHaveBeenCalledWith(TARGET_NODE.id);
    expect(relocateAssetSpy.mock.calls.slice(1)).toEqual([
      ['library:2026/IMG_0003.CR3', 'move', 'skip', '2026/France', 'IMG_0003.3.CR3'],
      ['library:2026/IMG_0003.JPG', 'move', 'skip', '2026/France', 'IMG_0003.3.JPG'],
    ]);
    expect(service.resultSummary()).toMatchObject({ total: 1, moved: 1 });
  });
});
