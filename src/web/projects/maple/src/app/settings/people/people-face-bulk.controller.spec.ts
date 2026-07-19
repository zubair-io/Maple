/**
 * Unit tests for `PeopleFaceBulkController` — the detail view's per-face
 * selection set and its bulk move/unassign/hide actions (#2084 extraction).
 * Plain-TS controller with deps threaded through the constructor, so it's
 * testable with fake deps and no TestBed — the same approach
 * `people-bulk.controller.spec.ts` and `people-detail.controller.spec.ts` use.
 */
import { signal } from '@angular/core';
import { Subject, of, throwError } from 'rxjs';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ApiPerson, ApiPersonDetail, ApiPersonFace } from '@maple-common';
import { PeopleFaceBulkController, type PeopleFaceBulkDeps } from './people-face-bulk.controller';
import type { Tone } from './people.vm';

function face(assetId: string): ApiPersonFace {
  return {
    assetId,
    faceIndex: 0,
    absPath: `/lib/${assetId}.jpg`,
    bbox: { x: 0.1, y: 0.1, w: 0.2, h: 0.2 },
    confidence: 0.9,
  };
}

function detailWith(overrides: Partial<ApiPersonDetail> = {}): ApiPersonDetail {
  return {
    id: 'current',
    name: 'Current Person',
    coverAssetId: null,
    coverBbox: null,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    faces: [face('f1'), face('f2')],
    suggestedMerge: null,
    ...overrides,
  };
}

describe('PeopleFaceBulkController — selection + bulk actions', () => {
  let assignFaceToPerson: ReturnType<typeof vi.fn>;
  let hideFace: ReturnType<typeof vi.fn>;
  let openDetail: ReturnType<typeof vi.fn<(id: string) => void>>;
  let refresh: ReturnType<typeof vi.fn<() => void>>;
  let toast: ReturnType<typeof vi.fn<(text: string, tone: Tone) => void>>;
  let selected: ReturnType<typeof signal<ApiPersonDetail | null>>;
  let visibleFaces: ReturnType<typeof signal<ApiPersonFace[]>>;
  let bulkBusy: ReturnType<typeof signal<number>>;
  let controller: PeopleFaceBulkController;

  beforeEach(() => {
    assignFaceToPerson = vi.fn(() => of({}));
    hideFace = vi.fn(() => of({}));
    openDetail = vi.fn<(id: string) => void>();
    refresh = vi.fn<() => void>();
    toast = vi.fn<(text: string, tone: Tone) => void>();
    selected = signal<ApiPersonDetail | null>(detailWith());
    visibleFaces = signal<ApiPersonFace[]>([face('f1'), face('f2')]);
    bulkBusy = signal<number>(0);

    const deps: PeopleFaceBulkDeps = {
      api: { assignFaceToPerson, hideFace } as unknown as PeopleFaceBulkDeps['api'],
      selected,
      visibleFaces,
      bulkBusy,
      openDetail,
      refresh,
      toast,
    };
    controller = new PeopleFaceBulkController(deps);
  });

  it('toggleFaceSelection adds then removes a face; isFaceSelected tracks it', () => {
    expect(controller.isFaceSelected(face('f1'))).toBe(false);

    controller.toggleFaceSelection(face('f1'));
    expect(controller.isFaceSelected(face('f1'))).toBe(true);
    expect(controller.selectedFaces().has('f1:0')).toBe(true);

    controller.toggleFaceSelection(face('f1'));
    expect(controller.isFaceSelected(face('f1'))).toBe(false);
    expect(controller.selectedFaces().size).toBe(0);
  });

  it('selectAllVisible selects every visible face; clearSelection empties the set', () => {
    controller.selectAllVisible();
    expect(controller.selectedFaces()).toEqual(new Set(['f1:0', 'f2:0']));

    controller.clearSelection();
    expect(controller.selectedFaces().size).toBe(0);
  });

  it('bulkMoveTo fans the assign call out over the selection and toasts the success count', async () => {
    controller.selectAllVisible();
    await controller.bulkMoveTo('target');

    expect(assignFaceToPerson).toHaveBeenCalledTimes(2);
    expect(assignFaceToPerson).toHaveBeenCalledWith('f1', 0, 'target');
    expect(assignFaceToPerson).toHaveBeenCalledWith('f2', 0, 'target');
    expect(toast).toHaveBeenCalledWith('Moved 2 faces.', 'success');
  });

  it('bulkMoveTo no-ops on a blank target; bulk actions no-op on an empty selection', async () => {
    controller.selectAllVisible();
    await controller.bulkMoveTo('   ');
    expect(assignFaceToPerson).not.toHaveBeenCalled();

    controller.clearSelection();
    await controller.bulkUnassign();
    await controller.bulkHide();
    expect(assignFaceToPerson).not.toHaveBeenCalled();
    expect(hideFace).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
  });

  it('bulkUnassign passes a null person; bulkHide calls hideFace', async () => {
    controller.toggleFaceSelection(face('f1'));
    await controller.bulkUnassign();
    expect(assignFaceToPerson).toHaveBeenCalledWith('f1', 0, null);
    expect(toast).toHaveBeenCalledWith('Unassigned 1 face.', 'success');

    controller.toggleFaceSelection(face('f2'));
    await controller.bulkHide();
    expect(hideFace).toHaveBeenCalledWith('f2', 0);
    expect(toast).toHaveBeenCalledWith('Hid 1 face.', 'success');
  });

  it('surfaces the success/failure split on a partial failure (allSettled, not all)', async () => {
    assignFaceToPerson.mockImplementation((assetId: string) =>
      assetId === 'f2' ? throwError(() => new Error('boom')) : of({}),
    );
    controller.selectAllVisible();
    await controller.bulkMoveTo('target');

    expect(toast).toHaveBeenCalledWith('Moved 1 face.', 'success');
    expect(toast).toHaveBeenCalledWith('1 face failed: boom', 'error');
  });

  it('always clears selection, refetches the open detail, and refreshes the list — even on total failure', async () => {
    assignFaceToPerson.mockImplementation(() => throwError(() => new Error('boom')));
    controller.selectAllVisible();
    await controller.bulkMoveTo('target');

    expect(toast).toHaveBeenCalledWith('2 faces failed: boom', 'error');
    expect(toast).not.toHaveBeenCalledWith(expect.anything(), 'success');
    expect(controller.selectedFaces().size).toBe(0);
    expect(openDetail).toHaveBeenCalledWith('current');
    expect(refresh).toHaveBeenCalled();
  });

  it('increments bulkBusy while the batch is in flight, decrements after', async () => {
    const deferred = new Subject<unknown>();
    assignFaceToPerson.mockReturnValueOnce(deferred.asObservable());

    controller.toggleFaceSelection(face('f1'));
    expect(bulkBusy()).toBe(0);
    const pending = controller.bulkMoveTo('target');
    await Promise.resolve();
    expect(bulkBusy()).toBe(1);

    deferred.next({});
    deferred.complete();
    await pending;
    expect(bulkBusy()).toBe(0);
  });

  it('drops stale selection keys that no longer match the live faces list', async () => {
    controller.selectAllVisible();
    // The detail refreshed mid-selection: f2 is gone.
    selected.set(detailWith({ faces: [face('f1')] }));
    await controller.bulkHide();

    expect(hideFace).toHaveBeenCalledTimes(1);
    expect(hideFace).toHaveBeenCalledWith('f1', 0);
  });
});
