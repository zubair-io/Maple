import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultAdjustmentModel } from '../models/adjustment-model';
import type { MapleFolderHandle } from '../folder-access/folder-access.types';
import { FolderAccessService } from '../folder-access/folder-access.service';
import { SidecarSaveStateService } from './sidecar-save-state.service';
import { XmpStoreService } from './xmp-store.service';

const FOLDER: MapleFolderHandle = { name: 'raws', read: true, write: true };
const CULLING = { rating: 0, flag: 'unflagged' as const, colorLabel: null, keywords: [] };

describe('XmpStoreService persistence contract', () => {
  let store: XmpStoreService;
  let saveState: SidecarSaveStateService;
  let writeFile: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    writeFile = vi.fn(async () => undefined);
    TestBed.configureTestingModule({
      providers: [{ provide: FolderAccessService, useValue: { writeFile } }],
    });
    store = TestBed.inject(XmpStoreService);
    saveState = TestBed.inject(SidecarSaveStateService);
  });

  afterEach(() => vi.useRealTimers());

  it('starts a real sibling-XMP write at 200ms and reports it saved', async () => {
    const model = { ...defaultAdjustmentModel(), exposure: 1.25 };
    store.scheduleWrite('asset-1', FOLDER, 'IMG_0001.dng', model, CULLING);

    await vi.advanceTimersByTimeAsync(199);
    expect(writeFile).not.toHaveBeenCalled();
    expect(saveState.phase()).toBe('unsaved');

    await vi.advanceTimersByTimeAsync(1);
    expect(writeFile).toHaveBeenCalledTimes(1);
    const [, filename, bytes] = writeFile.mock.calls[0];
    expect(filename).toBe('IMG_0001.xmp');
    expect(new TextDecoder().decode(bytes)).toContain('crs:Exposure2012="1.25"');
    expect(saveState.phase()).toBe('saved');
  });

  it('flushAll waits for a write whose debounce already fired', async () => {
    let finishWrite!: () => void;
    writeFile.mockImplementation(() => new Promise<void>((resolve) => (finishWrite = resolve)));
    store.scheduleWrite('asset-1', FOLDER, 'IMG_0001.dng', defaultAdjustmentModel(), CULLING);
    await vi.advanceTimersByTimeAsync(200);

    let flushed = false;
    const flush = store.flushAll().then(() => (flushed = true));
    await Promise.resolve();
    expect(flushed).toBe(false);

    finishWrite();
    await flush;
    expect(flushed).toBe(true);
  });

  it('keeps the edit unsaved and rejects flush when the filesystem write fails', async () => {
    writeFile.mockRejectedValue(new Error('Permission revoked'));
    store.scheduleWrite('asset-1', FOLDER, 'IMG_0001.dng', defaultAdjustmentModel(), CULLING);

    await expect(store.flushAll()).rejects.toThrow('Permission revoked');
    expect(saveState.phase()).toBe('error');
    expect(saveState.hasUnsavedChanges()).toBe(true);
  });
});
