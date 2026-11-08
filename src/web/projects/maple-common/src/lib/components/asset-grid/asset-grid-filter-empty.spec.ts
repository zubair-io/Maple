// asset-grid-filter-empty.spec.ts — the grid's "filter hides every photo"
// empty state (#5712). A persisted cull filter that matches nothing in a
// folder used to leave only the subfolder tiles (or "Folder is empty"),
// which read as broken thumbnails.

import { computed, signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AssetGridComponent, FILTER_EMPTY_ROW_HEIGHT } from './asset-grid.component';
import { LibraryStateService } from '../../state/library-state.service';
import type { CullFilter } from '../../state/browse-preferences.service';
import type { Asset, AssetId } from '../../models/asset';
import { STORAGE_KEYS, TypedStorage } from '../../util/typed-storage';

const matchesFilter = (a: Asset, f: CullFilter): boolean =>
  f === 'all' ||
  (f === 'picks' && a.flag === 'pick') ||
  (f === '4stars' && a.rating >= 4) ||
  (f === 'edited' && a.edited === true);

function photo(id: string, overrides: Partial<Asset> = {}): Asset {
  return {
    id: id as AssetId,
    filename: `${id}.jpg`,
    aspectRatio: 3 / 2,
    flag: 'unflagged',
    rating: 0,
    ...overrides,
  } as Asset;
}

describe('AssetGridComponent — filter hides every photo (#5712)', () => {
  let fixture: ComponentFixture<AssetGridComponent>;
  let storageSet: ReturnType<typeof vi.spyOn>;
  const filter = signal<CullFilter>('all');
  const searchQuery = signal('');
  const searchMatched = signal<Asset[]>([]);
  const gridFolders = signal<{ id: string; name: string; parentSourceId: string }[]>([]);

  beforeEach(() => {
    filter.set('all');
    searchQuery.set('');
    searchMatched.set([]);
    gridFolders.set([]);
    storageSet = vi.spyOn(TypedStorage, 'set').mockImplementation(() => {});
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe = vi.fn();
        disconnect = vi.fn();
      },
    );
    const assetsInSelectedFolder = computed(() =>
      searchMatched().filter((a) => matchesFilter(a, filter())),
    );
    TestBed.configureTestingModule({
      providers: [
        {
          provide: LibraryStateService,
          useValue: {
            currentFolder: () => undefined,
            selectedSourceLabel: () => 'lib',
            thumbSize: () => 140,
            sort: () => 'date',
            filter,
            searchQuery,
            selectedTotalCount: () => 0,
            foldersInSelectedFolder: gridFolders,
            assetsInSelectedFolder,
            searchMatchedAssetsInSelectedFolder: searchMatched,
            selectedAssetIds: () => new Set<AssetId>(),
            isSelecting: () => false,
            selectedFolderIds: () => new Set<string>(),
            backendLoading: () => false,
            backendError: () => undefined,
            ensureThumbnailUrl: vi.fn(),
            thumbnailFailed: () => false,
            subscribeThumbUrl: () => () => {},
            cancelQueuedThumbnail: vi.fn(),
            selectedSourceId: () => 'lib:2026',
          },
        },
        { provide: Router, useValue: { navigate: vi.fn() } },
      ],
    });
    fixture = TestBed.createComponent(AssetGridComponent);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function render(): HTMLElement {
    fixture.detectChanges();
    return fixture.nativeElement as HTMLElement;
  }

  async function renderRows(): Promise<HTMLElement> {
    const el = fixture.nativeElement as HTMLElement;
    el.style.height = '600px';
    fixture.autoDetectChanges();
    await fixture.whenStable();
    return el;
  }

  const rowKinds = () => fixture.componentInstance.gridRows().map((r) => r.kind);

  it('shows the per-filter empty state with the hidden photo count', async () => {
    searchMatched.set([photo('a1'), photo('a2')]);
    filter.set('picks');

    const el = await renderRows();

    expect(rowKinds()).toEqual(['filter-empty']);
    await expect.poll(() => el.querySelector('mui-empty-state')).not.toBeNull();
    expect(el.querySelector('mui-empty-state .title')?.textContent).toContain(
      'No picks in this folder',
    );
    expect(el.querySelector('mui-empty-state .message')?.textContent).toContain(
      '2 photos are hidden by the Picks filter.',
    );
    expect(el.querySelector('[role="status"]')?.textContent).toContain('No picks in this folder');
    expect(el.textContent).not.toContain('Folder is empty');
  });

  it('gives the virtual scroller the exact box height of the empty-state row', () => {
    searchMatched.set([photo('a1')]);
    filter.set('picks');

    expect(fixture.componentInstance.rowBoxHeights()).toEqual([FILTER_EMPTY_ROW_HEIGHT]);
  });

  it('Show all resets the filter, persists it like the filter pill, and keeps focus', async () => {
    searchMatched.set([photo('a1')]);
    filter.set('picks');
    const el = await renderRows();
    await expect.poll(() => el.querySelector('mui-empty-state mui-button button')).not.toBeNull();

    (el.querySelector('mui-empty-state mui-button button') as HTMLButtonElement).click();
    await fixture.whenStable();
    const after = el;

    expect(filter()).toBe('all');
    expect(storageSet).toHaveBeenCalledWith(STORAGE_KEYS.FILTER, 'all');
    expect(rowKinds()).toEqual(['images']);
    expect(after.querySelector('mui-empty-state')).toBeNull();
    expect(document.activeElement?.getAttribute('aria-label')).toBe('Filter: All');
  });

  it('sits below the subfolder tiles', () => {
    gridFolders.set([{ id: 'lib:2026/France', name: 'France', parentSourceId: 'lib:2026' }]);
    searchMatched.set([photo('a1')]);
    filter.set('picks');

    expect(rowKinds()).toEqual(['folders', 'filter-empty']);
  });

  it('words each filter', () => {
    searchMatched.set([photo('a1')]);
    const titles = (['4stars', 'edited'] as const).map((f) => {
      filter.set(f);
      return fixture.componentInstance.filterEmptyTitle();
    });

    expect(titles).toEqual(['No 4+ star photos in this folder', 'No edited photos in this folder']);
    expect(fixture.componentInstance.filterEmptyMessage()).toBe(
      '1 photo is hidden by the Edited filter.',
    );
  });

  it('says the search, not the folder, has no matches while a search is active', () => {
    searchMatched.set([photo('a1'), photo('a2')]);
    searchQuery.set('a');
    filter.set('picks');

    expect(fixture.componentInstance.filterEmptyTitle()).toBe('No picks match this search');
    expect(fixture.componentInstance.filterEmptyMessage()).toBe(
      '2 matching photos are hidden by the Picks filter.',
    );
  });

  it('stays hidden when no filter is active', () => {
    searchMatched.set([photo('a1')]);

    expect(render().querySelector('mui-empty-state')).toBeNull();
    expect(fixture.componentInstance.filterHidesAllPhotos()).toBe(false);
  });

  it('stays hidden when the filter matches some photos', () => {
    searchMatched.set([photo('a1'), photo('a2', { flag: 'pick' })]);
    filter.set('picks');

    expect(render().querySelector('mui-empty-state')).toBeNull();
    expect(rowKinds()).toEqual(['images']);
  });

  it('keeps "Folder is empty" for a folder with no photos at all', () => {
    filter.set('picks');

    const el = render();

    expect(el.querySelector('mui-empty-state')).toBeNull();
    expect(el.textContent).toContain('Folder is empty');
  });
});
