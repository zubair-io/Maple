// Unit tests for DropZoneComponent's drop routing (#2650): a drop that
// resolves to a reference mount opens/selects without copying, and a drop
// that falls back to copy-import says so.

import { signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { DropZoneComponent } from './drop-zone.component';
import { FolderAccessService } from '../../folder-access/folder-access.service';
import { LibraryStateService } from '../../state/library-state.service';
import { DropResolution, MapleFolderHandle } from '../../folder-access/folder-access.types';
import { Asset, AssetId } from '../../models/asset';

describe('DropZoneComponent drop routing', () => {
  let fixture: ComponentFixture<DropZoneComponent>;
  let component: DropZoneComponent;

  const folder: MapleFolderHandle = { name: 'Vacation', read: true, write: true };

  const state = {
    currentFolder: signal<MapleFolderHandle | null>(null),
    assets: signal<Asset[]>([]),
    selectedSourceId: signal<string>(''),
    selectAsset: vi.fn<(id: AssetId) => void>(),
    selectMany: vi.fn<(ids: AssetId[]) => void>(),
    openFolder: vi.fn<(f: MapleFolderHandle) => Promise<void>>(),
    addImportedAsset: vi.fn<(bytes: Uint8Array, name: string) => AssetId>(),
  };
  const folderAccess = {
    hasFsAccess: true,
    persistedHandles: signal([]),
    resolveDrop:
      vi.fn<
        (dt: DataTransfer, known: unknown[], onBeforePicker?: () => void) => Promise<DropResolution>
      >(),
    whenPersistedHandlesReady: vi.fn<() => Promise<void>>(),
    openFolder: vi.fn(),
    requestWriteAccess: vi.fn(),
  };
  const router = { navigate: vi.fn<() => Promise<boolean>>() };

  function asset(id: AssetId, filename: string, folderId: string): Asset {
    return {
      id,
      filename,
      folderId,
      rating: 0,
      flag: 'unflagged',
      colorLabel: null,
      thumbnailGradient: '',
      aspectRatio: 1.5,
    };
  }

  beforeEach(async () => {
    vi.clearAllMocks();
    state.currentFolder.set(null);
    state.assets.set([]);
    state.selectedSourceId.set('');
    state.openFolder.mockResolvedValue();
    router.navigate.mockResolvedValue(true);
    folderAccess.whenPersistedHandlesReady.mockResolvedValue();

    await TestBed.configureTestingModule({
      imports: [DropZoneComponent],
      providers: [
        { provide: FolderAccessService, useValue: folderAccess },
        { provide: LibraryStateService, useValue: state },
        { provide: Router, useValue: router },
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(DropZoneComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  function drop(dataTransfer: Partial<DataTransfer>): Promise<void> {
    return component.onDrop({
      preventDefault: vi.fn(),
      dataTransfer: dataTransfer as DataTransfer,
    } as unknown as DragEvent);
  }

  it('opens the folder and reports a reference for a whole-folder mount', async () => {
    folderAccess.resolveDrop.mockResolvedValue({
      kind: 'mounted',
      folder,
      filePaths: [],
      alreadyOpen: false,
    });
    state.selectedSourceId.set('f-vacation');

    await drop({});

    expect(state.openFolder).toHaveBeenCalledWith(folder);
    expect(component.dropStatus()).toMatchObject({
      kind: 'referenced',
      message: expect.stringContaining('Vacation'),
    });
    expect(component.dropStatus()?.message).toContain('no copy made');
  });

  it('skips reopening the folder and just selects when the drop is already inside it (already-mounted)', async () => {
    state.currentFolder.set(folder);
    state.selectedSourceId.set('f-vacation');
    state.assets.set([asset('l:a.dng', 'a.dng', 'f-vacation')]);
    folderAccess.resolveDrop.mockResolvedValue({
      kind: 'mounted',
      folder,
      filePaths: ['a.dng'],
      alreadyOpen: true,
    });

    await drop({});

    expect(state.openFolder).not.toHaveBeenCalled();
    expect(state.selectAsset).toHaveBeenCalledWith('l:a.dng');
    expect(router.navigate).toHaveBeenCalled();
  });

  it('selects every matched asset for a multi-file mount', async () => {
    state.selectedSourceId.set('f-vacation');
    state.assets.set([
      asset('l:a.dng', 'a.dng', 'f-vacation'),
      asset('l:b.dng', 'b.dng', 'f-vacation'),
    ]);
    folderAccess.resolveDrop.mockResolvedValue({
      kind: 'mounted',
      folder,
      filePaths: ['a.dng', 'b.dng'],
      alreadyOpen: false,
    });

    await drop({});

    expect(state.openFolder).toHaveBeenCalledWith(folder);
    expect(state.selectMany).toHaveBeenCalledWith(['l:a.dng', 'l:b.dng']);
  });

  it('falls back to copy-import and reports the reason when reference-mounting is not possible', async () => {
    const file = new File(['bytes'], 'a.dng');
    folderAccess.resolveDrop.mockResolvedValue({
      kind: 'copy-fallback',
      files: [file],
      reason: 'This browser cannot reference dropped files in place — copied instead.',
    });
    state.addImportedAsset.mockReturnValue('imported:a.dng');

    await drop({});

    expect(state.addImportedAsset).toHaveBeenCalled();
    expect(state.openFolder).not.toHaveBeenCalled();
    expect(component.dropStatus()).toMatchObject({
      kind: 'copied',
      message: expect.stringContaining('copied instead'),
    });
  });

  it('does nothing when the user cancels the confirmation picker', async () => {
    folderAccess.resolveDrop.mockResolvedValue({ kind: 'cancelled' });

    await drop({});

    expect(state.openFolder).not.toHaveBeenCalled();
    expect(state.addImportedAsset).not.toHaveBeenCalled();
    expect(component.dropStatus()).toBeNull();
  });

  it('surfaces access-denied as an actionable error rather than a generic failure, without touching state', async () => {
    folderAccess.resolveDrop.mockResolvedValue({ kind: 'access-denied', name: 'Archive' });

    await drop({});

    expect(component.openError()).toContain('Archive');
    expect(component.openError()).toContain('re-grant');
    expect(component.dropStatus()).toBeNull();
    expect(state.openFolder).not.toHaveBeenCalled();
    expect(state.addImportedAsset).not.toHaveBeenCalled();
  });

  it('shows a pending explanation before the seeded confirmation picker opens, driven by resolveDrop', async () => {
    let statusWhilePickerOpen: unknown;
    folderAccess.resolveDrop.mockImplementation(async (_dt, _known, onBeforePicker) => {
      onBeforePicker?.();
      statusWhilePickerOpen = component.dropStatus();
      return { kind: 'cancelled' };
    });

    await drop({});

    expect(statusWhilePickerOpen).toMatchObject({ kind: 'pending' });
    // Cancellation clears the pending line rather than leaving it stuck.
    expect(component.dropStatus()).toBeNull();
  });

  it('waits for persisted handles to finish loading before resolving the drop', async () => {
    const order: string[] = [];
    folderAccess.whenPersistedHandlesReady.mockImplementation(async () => {
      order.push('ready');
    });
    folderAccess.resolveDrop.mockImplementation(async () => {
      order.push('resolve');
      return { kind: 'cancelled' };
    });

    await drop({});

    expect(order).toEqual(['ready', 'resolve']);
  });
});
