// F2 rename on the focused tile (#2637, #5846 review): the tile carries no
// filename caption, so the rename field opens over the tile itself.

import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { describe, it, expect, vi } from 'vitest';

import { AssetTileComponent } from './asset-tile.component';
import { LibraryStateService } from '../../state/library-state.service';
import {
  ASSET_RENAME_CAPABILITY,
  type AssetRenameCapability,
  type RenameCollision,
} from '../../rename/asset-rename-capability';
import type { Asset, AssetId } from '../../models/asset';

const ASSET = {
  id: 'lib:2026/IMG_1.CR3' as AssetId,
  filename: 'IMG_1.CR3',
  thumbnailGradient: 'data:image/svg+xml,x',
} as Asset;

async function render() {
  const editingAssetId = signal<AssetId | null>(null);
  const collision = signal<RenameCollision | null>(null);
  const rename: AssetRenameCapability = {
    editingAssetId,
    error: signal(null),
    busy: signal(false),
    collision,
    disabledReason: () => null,
    startEditing: (asset) => editingAssetId.set(asset.id),
    cancel: () => editingAssetId.set(null),
    commit: vi.fn(),
    resolveCollision: vi.fn(),
  };
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    imports: [AssetTileComponent],
    providers: [
      {
        provide: LibraryStateService,
        useValue: {
          ensureThumbnailUrl: () => {},
          cancelQueuedThumbnail: () => {},
          subscribeThumbUrl: () => () => {},
          isSelecting: () => false,
          thumbnailFailed: () => false,
        },
      },
      { provide: ASSET_RENAME_CAPABILITY, useValue: rename },
    ],
  });
  await TestBed.compileComponents();
  const fixture = TestBed.createComponent(AssetTileComponent);
  fixture.componentRef.setInput('asset', ASSET);
  fixture.detectChanges();
  return { fixture, rename, collision };
}

async function settle(fixture: Awaited<ReturnType<typeof render>>['fixture']) {
  fixture.detectChanges();
  await fixture.whenStable();
  fixture.detectChanges();
}

describe('AssetTileComponent — F2 rename field', () => {
  it('opens the rename field over the tile when its asset starts editing', async () => {
    const { fixture, rename } = await render();
    const root = fixture.nativeElement as HTMLElement;
    expect(root.querySelector('[data-testid="tile-rename"]')).toBeNull();

    rename.startEditing(ASSET);
    await settle(fixture);

    const input = root.querySelector<HTMLInputElement>(
      '[data-testid="tile-rename"] input[type="text"]',
    );
    expect(input?.value).toBe('IMG_1.CR3');
  });

  it('names the JPEG and offers no Keep Both on a stack’s JPEG prompt', async () => {
    const { fixture, rename, collision } = await render();
    rename.startEditing(ASSET);
    collision.set({
      assetId: ASSET.id,
      filename: 'IMG_1.JPG',
      companion: { id: 'lib:2026/IMG_0.JPG', filename: 'IMG_0.JPG' },
    });
    await settle(fixture);

    const field = (fixture.nativeElement as HTMLElement).querySelector(
      '[data-testid="tile-rename"]',
    );
    expect(field?.textContent).toContain('"IMG_1.JPG" already exists');
    expect(field?.textContent).not.toContain('Keep Both');
    expect(field?.textContent).toContain('Replace');
  });
});
