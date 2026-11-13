import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { of, throwError } from 'rxjs';
import { describe, it, expect, vi, beforeEach } from 'vitest';

import { AssetRenameService } from './asset-rename.service';
import { BunApiBackendService } from '../api/bun-api-backend.service';
import { LibraryStateService } from '../state/library-state.service';
import type { Asset } from '../models/asset';
import { FolderOccupancyService } from '../stack/folder-occupancy.service';

const ASSET: Asset = {
  id: 'library:2026/IMG_0001.CR3',
  filename: 'IMG_0001.CR3',
  folderId: 'library:2026',
  rating: 0,
  flag: 'unflagged',
  colorLabel: null,
  thumbnailGradient: '',
  aspectRatio: 1.5,
};

describe('AssetRenameService', () => {
  let renameAssetSpy: ReturnType<typeof vi.fn>;
  let stateRenameSpy: ReturnType<typeof vi.fn>;
  let navigateSpy: ReturnType<typeof vi.fn>;
  let refreshSpy: ReturnType<typeof vi.fn>;
  let occupiedSpy: ReturnType<typeof vi.fn>;
  let service: AssetRenameService;

  function setup(
    opts: { backend?: 'self-hosted' | 'hosted'; focusedAssetId?: string | null } = {},
  ) {
    renameAssetSpy = vi.fn();
    stateRenameSpy = vi.fn();
    navigateSpy = vi.fn();
    refreshSpy = vi.fn();
    occupiedSpy = vi.fn();

    const fakeApi = { renameAsset: renameAssetSpy };
    const fakeState = {
      backend: opts.backend ?? 'self-hosted',
      focusedAssetId: () => (opts.focusedAssetId === undefined ? null : opts.focusedAssetId),
      renameAsset: stateRenameSpy,
      selectedSourceId: () => 'library:2026',
      refreshFolderListing: refreshSpy,
    };
    const fakeRouter = { url: '/browse/library', navigate: navigateSpy };

    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        AssetRenameService,
        { provide: BunApiBackendService, useValue: fakeApi },
        { provide: LibraryStateService, useValue: fakeState },
        { provide: Router, useValue: fakeRouter },
        { provide: FolderOccupancyService, useValue: { occupiedNames: occupiedSpy } },
      ],
    });
    service = TestBed.inject(AssetRenameService);
  }

  beforeEach(() => setup());

  it('disables rename on the Hosted backend with an explanatory reason', () => {
    setup({ backend: 'hosted' });
    expect(service.disabledReason(ASSET)).toMatch(/self hosted/i);
  });

  it('disables rename for an asset with no slug:relPath address', () => {
    setup({ backend: 'self-hosted' });
    expect(service.disabledReason({ ...ASSET, id: 'no-colon-id' })).not.toBeNull();
  });

  it('allows rename for a normal Self Hosted asset', () => {
    expect(service.disabledReason(ASSET)).toBeNull();
  });

  it('startEditing opens the field; cancel closes it and clears error/collision', () => {
    service.startEditing(ASSET);
    expect(service.editingAssetId()).toBe(ASSET.id);
    service.cancel();
    expect(service.editingAssetId()).toBeNull();
    expect(service.error()).toBeNull();
    expect(service.collision()).toBeNull();
  });

  it('startEditing is a no-op when renaming is disabled', () => {
    setup({ backend: 'hosted' });
    service.startEditing(ASSET);
    expect(service.editingAssetId()).toBeNull();
  });

  it('commit() with an unchanged/empty name cancels without calling the API', () => {
    service.startEditing(ASSET);
    service.commit(ASSET, ASSET.filename);
    expect(renameAssetSpy).not.toHaveBeenCalled();
    expect(service.editingAssetId()).toBeNull();

    service.startEditing(ASSET);
    service.commit(ASSET, '   ');
    expect(renameAssetSpy).not.toHaveBeenCalled();
    expect(service.editingAssetId()).toBeNull();
  });

  it('a successful commit calls the API with collision:skip and repoints local state', () => {
    renameAssetSpy.mockReturnValue(
      of({
        kind: 'renamed',
        newAbsPath: '/lib/2026/IMG_0002.CR3',
        newPath: '2026',
        newFilename: 'IMG_0002.CR3',
        renamedOnCollision: false,
        extensionChanged: false,
      }),
    );
    service.startEditing(ASSET);
    service.commit(ASSET, 'IMG_0002.CR3');

    expect(renameAssetSpy).toHaveBeenCalledWith(ASSET.id, 'IMG_0002.CR3', 'skip');
    expect(stateRenameSpy).toHaveBeenCalledWith(
      ASSET.id,
      'library:2026/IMG_0002.CR3',
      'IMG_0002.CR3',
    );
    expect(service.editingAssetId()).toBeNull();
    expect(service.busy()).toBe(false);
  });

  it('a collision outcome surfaces inline instead of the API silently overwriting', () => {
    renameAssetSpy.mockReturnValue(of({ kind: 'skipped', reason: 'collision' }));
    service.startEditing(ASSET);
    service.commit(ASSET, 'IMG_0002.CR3');

    expect(service.collision()).toEqual({ assetId: ASSET.id, filename: 'IMG_0002.CR3' });
    // Field stays open so the user can pick Replace / Keep Both.
    expect(service.editingAssetId()).toBe(ASSET.id);
  });

  it('resolveCollision(replace) retries with collision:replace', () => {
    renameAssetSpy.mockReturnValueOnce(of({ kind: 'skipped', reason: 'collision' }));
    service.startEditing(ASSET);
    service.commit(ASSET, 'IMG_0002.CR3');

    renameAssetSpy.mockReturnValueOnce(
      of({
        kind: 'renamed',
        newAbsPath: '/lib/2026/IMG_0002.CR3',
        newPath: '2026',
        newFilename: 'IMG_0002.CR3',
        renamedOnCollision: false,
        extensionChanged: false,
      }),
    );
    service.resolveCollision(ASSET, 'replace');

    expect(renameAssetSpy).toHaveBeenLastCalledWith(ASSET.id, 'IMG_0002.CR3', 'replace');
    expect(service.editingAssetId()).toBeNull();
  });

  it('resolveCollision(skip) just cancels', () => {
    renameAssetSpy.mockReturnValue(of({ kind: 'skipped', reason: 'collision' }));
    service.startEditing(ASSET);
    service.commit(ASSET, 'IMG_0002.CR3');

    service.resolveCollision(ASSET, 'skip');
    expect(service.editingAssetId()).toBeNull();
    expect(service.collision()).toBeNull();
  });

  it('a server rejection surfaces inline via the error signal, field stays open', () => {
    renameAssetSpy.mockReturnValue(
      throwError(() => ({ error: { error: 'CON is a reserved name' } })),
    );
    service.startEditing(ASSET);
    service.commit(ASSET, 'CON');

    expect(service.error()).toBe('CON is a reserved name');
    expect(service.editingAssetId()).toBe(ASSET.id);
    expect(service.busy()).toBe(false);
  });

  it('navigates the open /edit route to the new address when the renamed asset is focused', () => {
    setup({ focusedAssetId: ASSET.id });
    (TestBed.inject(Router) as unknown as { url: string }).url = '/edit/library/2026/IMG_0001.CR3';
    renameAssetSpy.mockReturnValue(
      of({
        kind: 'renamed',
        newAbsPath: '/lib/2026/IMG_0002.CR3',
        newPath: '2026',
        newFilename: 'IMG_0002.CR3',
        renamedOnCollision: false,
        extensionChanged: false,
      }),
    );
    service.startEditing(ASSET);
    service.commit(ASSET, 'IMG_0002.CR3');

    expect(navigateSpy).toHaveBeenCalledWith(
      ['/edit', 'library', '2026', 'IMG_0002.CR3'],
      expect.objectContaining({ replaceUrl: true }),
    );
  });

  it('does not navigate when the renamed asset was not the focused/open one', () => {
    setup({ focusedAssetId: 'some-other-asset' });
    renameAssetSpy.mockReturnValue(
      of({
        kind: 'renamed',
        newAbsPath: '/lib/2026/IMG_0002.CR3',
        newPath: '2026',
        newFilename: 'IMG_0002.CR3',
        renamedOnCollision: false,
        extensionChanged: false,
      }),
    );
    service.startEditing(ASSET);
    service.commit(ASSET, 'IMG_0002.CR3');

    expect(navigateSpy).not.toHaveBeenCalled();
  });

  describe('RAW+JPEG stack (#5846)', () => {
    const STACKED: Asset = {
      ...ASSET,
      stack: {
        companion: { id: 'library:2026/IMG_0001.JPG', name: 'IMG_0001.JPG', ext: 'jpg', size: 1 },
      },
    };
    const renamed = (newFilename: string) =>
      of({
        kind: 'renamed',
        newAbsPath: `/lib/2026/${newFilename}`,
        newPath: '2026',
        newFilename,
        renamedOnCollision: false,
        extensionChanged: false,
      });

    it('renames the JPEG to the RAW’s new stem, then closes the field and re-pulls the listing', () => {
      renameAssetSpy.mockImplementation((_id: string, name: string) => renamed(name));
      service.startEditing(STACKED);
      service.commit(STACKED, 'Trip_01.CR3');

      expect(renameAssetSpy.mock.calls).toEqual([
        [STACKED.id, 'Trip_01.CR3', 'skip'],
        ['library:2026/IMG_0001.JPG', 'Trip_01.JPG', 'skip'],
      ]);
      expect(refreshSpy).toHaveBeenCalledWith('library:2026');
      expect(service.editingAssetId()).toBeNull();
      expect(service.error()).toBeNull();
    });

    it('does not touch the JPEG when the RAW rename collides', () => {
      renameAssetSpy.mockReturnValue(of({ kind: 'skipped', reason: 'collision' }));
      service.startEditing(STACKED);
      service.commit(STACKED, 'Trip_01.CR3');

      expect(renameAssetSpy).toHaveBeenCalledTimes(1);
      expect(service.collision()).toEqual({ assetId: STACKED.id, filename: 'Trip_01.CR3' });
    });

    it('never sends Replace chosen for the RAW to the JPEG: the JPEG gets its own prompt', () => {
      renameAssetSpy
        .mockReturnValueOnce(of({ kind: 'skipped', reason: 'collision' }))
        .mockReturnValueOnce(renamed('Trip_01.CR3'))
        .mockReturnValueOnce(of({ kind: 'skipped', reason: 'collision' }));
      service.startEditing(STACKED);
      service.commit(STACKED, 'Trip_01.CR3');
      service.resolveCollision(STACKED, 'replace');

      expect(renameAssetSpy.mock.calls).toEqual([
        [STACKED.id, 'Trip_01.CR3', 'skip'],
        [STACKED.id, 'Trip_01.CR3', 'replace'],
        ['library:2026/IMG_0001.JPG', 'Trip_01.JPG', 'skip'],
      ]);
      expect(service.collision()).toEqual({
        assetId: 'library:2026/Trip_01.CR3',
        filename: 'Trip_01.JPG',
        companion: { id: 'library:2026/IMG_0001.JPG', filename: 'IMG_0001.JPG' },
      });
    });

    it('replaces the JPEG target only after the user chooses Replace on the JPEG’s prompt', () => {
      renameAssetSpy
        .mockReturnValueOnce(renamed('Trip_01.CR3'))
        .mockReturnValueOnce(of({ kind: 'skipped', reason: 'collision' }))
        .mockReturnValueOnce(renamed('Trip_01.JPG'));
      service.startEditing(STACKED);
      service.commit(STACKED, 'Trip_01.CR3');
      const raw = { ...STACKED, id: 'library:2026/Trip_01.CR3', filename: 'Trip_01.CR3' };
      service.resolveCollision(raw, 'keep-both');
      expect(renameAssetSpy).toHaveBeenCalledTimes(2);

      service.resolveCollision(raw, 'replace');
      expect(renameAssetSpy).toHaveBeenLastCalledWith(
        'library:2026/IMG_0001.JPG',
        'Trip_01.JPG',
        'replace',
      );
      expect(service.editingAssetId()).toBeNull();
    });

    it('keeps the field open on the renamed RAW while the JPEG’s prompt is pending', () => {
      renameAssetSpy
        .mockReturnValueOnce(renamed('Trip_01.CR3'))
        .mockReturnValueOnce(of({ kind: 'skipped', reason: 'collision' }));
      service.startEditing(STACKED);
      service.commit(STACKED, 'Trip_01.CR3');

      expect(service.editingAssetId()).toBe('library:2026/Trip_01.CR3');
      expect(service.busy()).toBe(false);
      service.resolveCollision({ ...STACKED, id: 'library:2026/Trip_01.CR3' }, 'skip');
      expect(refreshSpy).toHaveBeenCalledWith('library:2026');
      expect(service.editingAssetId()).toBeNull();
    });

    it('reports a JPEG rename that fails outright on the renamed RAW’s field', () => {
      renameAssetSpy
        .mockReturnValueOnce(renamed('Trip_01.CR3'))
        .mockReturnValueOnce(throwError(() => new Error('disk full')));
      service.startEditing(STACKED);
      service.commit(STACKED, 'Trip_01.CR3');

      expect(service.error()).toContain('IMG_0001.JPG could not be renamed to Trip_01.JPG');
      expect(service.error()).toContain('disk full');
      expect(service.editingAssetId()).toBe('library:2026/Trip_01.CR3');
    });

    it('Keep Both picks one stem free for the RAW, the JPEG and their sidecar', () => {
      occupiedSpy.mockReturnValue(
        of(new Set(['img_0001.cr3', 'img_0001.jpg', 'trip_01.cr3', 'trip_01.1.jpg'])),
      );
      renameAssetSpy
        .mockReturnValueOnce(of({ kind: 'skipped', reason: 'collision' }))
        .mockImplementation((_id: string, name: string) => renamed(name));
      service.startEditing(STACKED);
      service.commit(STACKED, 'Trip_01.CR3');
      service.resolveCollision(STACKED, 'keep-both');

      expect(occupiedSpy).toHaveBeenCalledWith('library:2026');
      expect(renameAssetSpy.mock.calls.slice(1)).toEqual([
        [STACKED.id, 'Trip_01.2.CR3', 'skip'],
        ['library:2026/IMG_0001.JPG', 'Trip_01.2.JPG', 'skip'],
      ]);
    });
  });
});
