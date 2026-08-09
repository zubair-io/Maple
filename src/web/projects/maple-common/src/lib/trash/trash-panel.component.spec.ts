import { TestBed } from '@angular/core/testing';
import { of } from 'rxjs';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TrashPanelComponent } from './trash-panel.component';
import { TrashApiService } from '../api/trash-api.service';
import { TrashService } from './trash.service';
import type { TrashItem } from './trash.types';

const ITEM_A: TrashItem = {
  assetId: 'a-1',
  filename: 'IMG_0001.CR3',
  originalRelativePath: 'Vacation/IMG_0001.CR3',
  trashRelativePath: '.maple/trash/Vacation/IMG_0001.CR3',
  size: 1024,
  mtime: '2026-01-01T00:00:00Z',
  deletedAt: '2026-01-02T00:00:00Z',
};

const ITEM_B: TrashItem = {
  ...ITEM_A,
  assetId: 'a-2',
  filename: 'IMG_0002.CR3',
};

describe('TrashPanelComponent', () => {
  let listTrashSpy: ReturnType<typeof vi.fn>;
  let deleteAssetSpy: ReturnType<typeof vi.fn>;
  let notifyLibraryMutatedSpy: ReturnType<typeof vi.fn>;

  function setup(items: TrashItem[] = [ITEM_A, ITEM_B]) {
    listTrashSpy = vi.fn().mockReturnValue(of({ items, nextCursor: null }));
    deleteAssetSpy = vi.fn();
    notifyLibraryMutatedSpy = vi.fn();

    const fakeApi = {
      listTrash: listTrashSpy,
      restoreAsset: vi.fn(),
      restoreFolder: vi.fn(),
      deleteAsset: deleteAssetSpy,
    };
    const fakeTrashService = { notifyLibraryMutated: notifyLibraryMutatedSpy };

    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        { provide: TrashApiService, useValue: fakeApi },
        { provide: TrashService, useValue: fakeTrashService },
      ],
    });
    const fixture = TestBed.createComponent(TrashPanelComponent);
    fixture.componentRef.setInput('libraryId', 'lib-1');
    fixture.componentRef.setInput('libraryLabel', 'Photos');
    fixture.detectChanges();
    return fixture;
  }

  beforeEach(() => setup());

  it('loads the first page on mount', () => {
    setup();
    expect(listTrashSpy).toHaveBeenCalledWith('lib-1', null);
  });

  describe('single-item Delete Permanently — intent=purge', () => {
    it('sends intent=purge and removes the row on ok', () => {
      const fixture = setup([ITEM_A]);
      deleteAssetSpy.mockReturnValue(of({ kind: 'ok' }));
      fixture.componentInstance.requestDeleteItem(ITEM_A);
      fixture.componentInstance.onConfirmDelete();
      expect(deleteAssetSpy).toHaveBeenCalledWith(ITEM_A.assetId, 'purge');
      expect(fixture.componentInstance.items()).toEqual([]);
      expect(fixture.componentInstance.confirmTarget()).toBeNull();
      expect(notifyLibraryMutatedSpy).toHaveBeenCalledWith('lib-1');
    });

    // #2749 — the dialog says "cannot be undone"; if the server reports
    // the asset was actually live (restored elsewhere since this row
    // loaded), the panel must NOT silently re-trash it to make that true.
    it('on a state=live 409, reports "restored elsewhere" and refreshes instead of treating it as deleted', () => {
      const fixture = setup([ITEM_A]);
      deleteAssetSpy.mockReturnValue(of({ kind: 'conflict', state: 'live' }));
      fixture.componentInstance.requestDeleteItem(ITEM_A);
      fixture.componentInstance.onConfirmDelete();
      expect(fixture.componentInstance.toast()).toMatch(/restored elsewhere/i);
      expect(fixture.componentInstance.toast()).toContain(ITEM_A.filename);
      // Re-fetched (not just filtered client-side) — listTrash called again.
      expect(listTrashSpy.mock.calls.length).toBeGreaterThanOrEqual(2);
      expect(notifyLibraryMutatedSpy).toHaveBeenCalledWith('lib-1');
    });

    it('never claims success text when the outcome was a conflict', () => {
      const fixture = setup([ITEM_A]);
      deleteAssetSpy.mockReturnValue(of({ kind: 'conflict', state: 'live' }));
      fixture.componentInstance.requestDeleteItem(ITEM_A);
      fixture.componentInstance.onConfirmDelete();
      expect(fixture.componentInstance.toast()).not.toMatch(/^Permanently deleted/);
    });
  });

  describe('Empty Trash — intent=purge batch', () => {
    it('deletes every item and reports a clean success toast', async () => {
      const fixture = setup([ITEM_A, ITEM_B]);
      deleteAssetSpy.mockReturnValue(of({ kind: 'ok' }));
      fixture.componentInstance.requestDeleteAll();
      fixture.componentInstance.onConfirmDelete();
      await vi.waitFor(() => expect(fixture.componentInstance.confirmBusy()).toBe(false));
      expect(deleteAssetSpy).toHaveBeenCalledWith(ITEM_A.assetId, 'purge');
      expect(deleteAssetSpy).toHaveBeenCalledWith(ITEM_B.assetId, 'purge');
      expect(fixture.componentInstance.toast()).toBe('Permanently deleted 2 item(s).');
    });

    it('reports per-item conflicts by filename, distinct from real failures', async () => {
      const fixture = setup([ITEM_A, ITEM_B]);
      deleteAssetSpy.mockImplementation((id: string) =>
        id === ITEM_A.assetId ? of({ kind: 'conflict', state: 'live' }) : of({ kind: 'ok' }),
      );
      fixture.componentInstance.requestDeleteAll();
      fixture.componentInstance.onConfirmDelete();
      await vi.waitFor(() => expect(fixture.componentInstance.confirmBusy()).toBe(false));
      const toast = fixture.componentInstance.toast();
      expect(toast).toContain('Permanently deleted 1 item(s)');
      expect(toast).toContain('restored elsewhere');
      expect(toast).toContain(ITEM_A.filename);
      // A conflict re-fetches the listing rather than trusting the
      // client-filtered array.
      expect(listTrashSpy.mock.calls.length).toBeGreaterThanOrEqual(2);
    });
  });
});
