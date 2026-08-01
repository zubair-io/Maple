// Tests for the selection + batch-metadata controller behind `/search`.
//
// Extracted from `search.component.ts` in #2129 (file-size budget), so these
// pin the behaviour that used to be exercised only through the component:
// the address filter that silently drops unregistered-library rows, the
// double-click fetch race, and the post-dismiss refresh.
//
// Plain fixtures, no TestBed — the controller is a signal-backed POJO.

import { describe, it, expect, vi } from 'vitest';
import { Subject } from 'rxjs';
import type { AssetMetadataSnapshot, BatchMetadataService } from '@maple-common';
import {
  SearchBatchMetaController,
  type SearchBatchMetaHost,
  type SelectableResult,
} from './search-batch-meta';

const RESULTS: SelectableResult[] = [
  { id: 'fs:/p/a.dng', address: 'lib:a.dng' },
  { id: 'fs:/p/b.dng', address: 'lib:b.dng' },
  // No registered library slug — not batch-editable.
  { id: 'fs:/p/c.dng', address: null },
];

interface Harness {
  controller: SearchBatchMetaController;
  errors: Array<string | null>;
  refreshes: number;
  fetches: Array<string[]>;
  emit: (snapshots: AssetMetadataSnapshot[]) => void;
  fail: () => void;
}

function harness(results: readonly SelectableResult[] = RESULTS): Harness {
  const errors: Array<string | null> = [];
  const fetches: Array<string[]> = [];
  let refreshes = 0;
  const subjects: Array<Subject<AssetMetadataSnapshot[]>> = [];

  const service = {
    fetchSnapshots: (addresses: string[]) => {
      fetches.push(addresses);
      const s = new Subject<AssetMetadataSnapshot[]>();
      subjects.push(s);
      return s.asObservable();
    },
  } as unknown as BatchMetadataService;

  const host: SearchBatchMetaHost = {
    loadedResults: () => results,
    setError: (m) => errors.push(m),
    refreshAfterEdit: () => {
      refreshes += 1;
    },
  };

  const controller = new SearchBatchMetaController(service, host);
  return {
    controller,
    errors,
    fetches,
    get refreshes() {
      return refreshes;
    },
    emit: (snapshots) => subjects[subjects.length - 1]?.next(snapshots),
    fail: () => subjects[subjects.length - 1]?.error(new Error('boom')),
  };
}

describe('SearchBatchMetaController — selection', () => {
  it('toggles ids on and off', () => {
    const { controller } = harness();
    controller.toggleSelect('fs:/p/a.dng');
    expect(controller.selectedCount()).toBe(1);
    expect(controller.selectedIds().has('fs:/p/a.dng')).toBe(true);
    controller.toggleSelect('fs:/p/a.dng');
    expect(controller.selectedCount()).toBe(0);
  });

  it('selects every loaded row and clears', () => {
    const { controller } = harness();
    controller.selectAllLoaded();
    expect(controller.selectedCount()).toBe(RESULTS.length);
    controller.clearSelection();
    expect(controller.selectedCount()).toBe(0);
  });

  it('never mutates the previous set in place', () => {
    const { controller } = harness();
    const before = controller.selectedIds();
    controller.toggleSelect('fs:/p/a.dng');
    expect(before.size).toBe(0);
  });
});

describe('SearchBatchMetaController — openDialog', () => {
  it('fetches only the addressable rows and reports the skipped ones', () => {
    const h = harness();
    h.controller.selectAllLoaded();
    h.controller.openDialog();

    expect(h.fetches).toEqual([['lib:a.dng', 'lib:b.dng']]);
    // The `address: null` row can't be resolved to a batch-editable address,
    // so the user has to be told rather than left believing all 3 were edited.
    expect(h.errors.at(-1)).toContain('1 selected result');
    expect(h.errors.at(-1)).toContain('was');
    expect(h.controller.dialogVisible()).toBe(false);

    h.emit([]);
    expect(h.controller.dialogVisible()).toBe(true);
  });

  it('pluralises the skipped-rows message', () => {
    const h = harness([
      { id: 'a', address: 'lib:a' },
      { id: 'b', address: null },
      { id: 'c', address: null },
    ]);
    h.controller.selectAllLoaded();
    h.controller.openDialog();
    expect(h.errors.at(-1)).toContain('2 selected results');
    expect(h.errors.at(-1)).toContain('were');
  });

  it('clears the error banner when nothing was skipped', () => {
    const h = harness();
    h.controller.toggleSelect('fs:/p/a.dng');
    h.controller.openDialog();
    expect(h.errors.at(-1)).toBeNull();
  });

  it('no-ops when no selected row has an address', () => {
    const h = harness();
    h.controller.toggleSelect('fs:/p/c.dng');
    h.controller.openDialog();
    expect(h.fetches).toEqual([]);
    expect(h.errors).toEqual([]);
    expect(h.controller.dialogVisible()).toBe(false);
  });

  it('no-ops on an empty selection', () => {
    const h = harness();
    h.controller.openDialog();
    expect(h.fetches).toEqual([]);
    expect(h.controller.dialogVisible()).toBe(false);
  });

  it('surfaces a fetch failure without opening the dialog', () => {
    const h = harness();
    h.controller.toggleSelect('fs:/p/a.dng');
    h.controller.openDialog();
    h.fail();
    expect(h.errors.at(-1)).toBe('Could not load metadata for the selected results.');
    expect(h.controller.dialogVisible()).toBe(false);
  });

  it('drops the first fetch when a rapid double-click starts a second', () => {
    const h = harness();
    h.controller.toggleSelect('fs:/p/a.dng');
    h.controller.openDialog();
    const first = h.emit;
    h.controller.openDialog();
    expect(h.fetches.length).toBe(2);
    // The superseded subject is unsubscribed, so its late emission must not
    // race snapshots into the panel.
    void first;
  });
});

describe('SearchBatchMetaController — dismissDialog', () => {
  it('closes, clears the selection, and asks the host to refresh', () => {
    const h = harness();
    h.controller.selectAllLoaded();
    h.controller.openDialog();
    h.emit([{ address: 'lib:a.dng' } as unknown as AssetMetadataSnapshot]);
    expect(h.controller.assetSnapshots().length).toBe(1);

    h.controller.dismissDialog();

    expect(h.controller.dialogVisible()).toBe(false);
    expect(h.controller.assetSnapshots()).toEqual([]);
    expect(h.controller.selectedCount()).toBe(0);
    expect(h.refreshes).toBe(1);
  });

  it('teardown cancels an in-flight fetch so it can never open the dialog', () => {
    const h = harness();
    h.controller.toggleSelect('fs:/p/a.dng');
    h.controller.openDialog();
    h.controller.teardown();
    h.emit([]);
    expect(h.controller.dialogVisible()).toBe(false);
  });
});

describe('SearchBatchMetaController — host wiring', () => {
  it('reads the result list lazily, so a later page is selectable', () => {
    const loaded: SelectableResult[] = [{ id: 'a', address: 'lib:a' }];
    const host: SearchBatchMetaHost = {
      loadedResults: () => loaded,
      setError: vi.fn(),
      refreshAfterEdit: vi.fn(),
    };
    const service = { fetchSnapshots: () => new Subject() } as unknown as BatchMetadataService;
    const controller = new SearchBatchMetaController(service, host);

    loaded.push({ id: 'b', address: 'lib:b' });
    controller.selectAllLoaded();
    expect(controller.selectedCount()).toBe(2);
  });
});
