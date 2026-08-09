// Unit tests for FolderAccessService.resolveDrop (#2650) — the drop-to-mount
// routing that reference-mounts an OS drop via File System Access when the
// browser supports it, and falls back to copy-import otherwise.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { FolderAccessService } from './folder-access.service';
import type { KnownFolder } from './folder-access.types';

// ── Fixtures ─────────────────────────────────────────────────────────────────

function fileHandle(name: string): FileSystemFileHandle {
  return { kind: 'file', name } as unknown as FileSystemFileHandle;
}

function dirHandle(
  name: string,
  opts: {
    resolveMap?: Record<string, string[] | null>;
    isSameEntry?: boolean;
    permission?: 'granted' | 'denied';
  } = {},
): FileSystemDirectoryHandle {
  const resolveMap = opts.resolveMap ?? {};
  return {
    kind: 'directory',
    name,
    queryPermission: vi.fn().mockResolvedValue(opts.permission ?? 'granted'),
    requestPermission: vi.fn().mockResolvedValue(opts.permission ?? 'granted'),
    isSameEntry: vi.fn().mockResolvedValue(opts.isSameEntry ?? false),
    resolve: vi.fn(async (h: FileSystemHandle) => resolveMap[h.name] ?? null),
  } as unknown as FileSystemDirectoryHandle;
}

interface FakeItem {
  kind: 'file';
  getAsFileSystemHandle: () => Promise<FileSystemHandle | null>;
}

function dataTransferFor(handles: (FileSystemHandle | null)[], files: File[] = []): DataTransfer {
  const items: FakeItem[] = handles.map((h) => ({
    kind: 'file',
    getAsFileSystemHandle: vi.fn().mockResolvedValue(h),
  }));
  return { items, files } as unknown as DataTransfer;
}

function knownFolder(native: FileSystemDirectoryHandle, isCurrent: boolean): KnownFolder {
  return { handle: { name: native.name, read: true, write: true, native }, native, isCurrent };
}

// ── Backend detection helper ────────────────────────────────────────────────

interface WindowWithDirectoryPicker extends Window {
  showDirectoryPicker: (opts?: {
    mode?: string;
    id?: string;
    startIn?: unknown;
  }) => Promise<FileSystemDirectoryHandle>;
}

function picker(): ReturnType<typeof vi.fn> {
  return (window as unknown as WindowWithDirectoryPicker)
    .showDirectoryPicker as unknown as ReturnType<typeof vi.fn>;
}

function withFsAccessBackend(): () => void {
  const original = Object.getOwnPropertyDescriptor(window, 'showDirectoryPicker');
  Object.defineProperty(window, 'showDirectoryPicker', {
    configurable: true,
    value: vi.fn(),
  });
  return () => {
    if (original) Object.defineProperty(window, 'showDirectoryPicker', original);
    else Reflect.deleteProperty(window, 'showDirectoryPicker');
  };
}

describe('FolderAccessService.resolveDrop', () => {
  let restoreBackend: (() => void) | null = null;

  afterEach(() => {
    restoreBackend?.();
    restoreBackend = null;
  });

  it('falls back to copy-import when the browser has no File System Access support', async () => {
    // No window.showDirectoryPicker — service detects the fallback backend.
    const service = new FolderAccessService();
    const file = new File(['x'], 'a.dng');
    const resolution = await service.resolveDrop(dataTransferFor([], [file]), []);

    expect(resolution).toMatchObject({ kind: 'copy-fallback', files: [file] });
  });

  it('mounts a single dropped folder directly, like Open folder', async () => {
    restoreBackend = withFsAccessBackend();
    const service = new FolderAccessService();
    const folder = dirHandle('Vacation');
    const resolution = await service.resolveDrop(dataTransferFor([folder]), []);

    expect(resolution).toMatchObject({
      kind: 'mounted',
      filePaths: [],
      alreadyOpen: false,
      folder: { name: 'Vacation', native: folder },
    });
  });

  it('flags a dropped folder as already-open when it matches the current folder', async () => {
    restoreBackend = withFsAccessBackend();
    const service = new FolderAccessService();
    const current = dirHandle('Vacation', { isSameEntry: true });
    const dropped = dirHandle('Vacation');
    const resolution = await service.resolveDrop(dataTransferFor([dropped]), [
      knownFolder(current, true),
    ]);

    expect(resolution).toMatchObject({ kind: 'mounted', alreadyOpen: true });
  });

  it('reference-mounts loose files already inside the currently open folder without a picker', async () => {
    restoreBackend = withFsAccessBackend();
    const service = new FolderAccessService();
    const a = fileHandle('a.dng');
    const b = fileHandle('b.dng');
    const current = dirHandle('Vacation', {
      resolveMap: { 'a.dng': ['a.dng'], 'b.dng': ['b.dng'] },
    });

    const resolution = await service.resolveDrop(dataTransferFor([a, b]), [
      knownFolder(current, true),
    ]);

    expect(resolution).toMatchObject({
      kind: 'mounted',
      alreadyOpen: true,
      filePaths: ['a.dng', 'b.dng'],
    });
    expect(picker()).not.toHaveBeenCalled();
  });

  it('reference-mounts loose files inside a known-but-not-current folder without a picker', async () => {
    restoreBackend = withFsAccessBackend();
    const service = new FolderAccessService();
    const a = fileHandle('a.dng');
    const persisted = dirHandle('Archive', { resolveMap: { 'a.dng': ['a.dng'] } });

    const resolution = await service.resolveDrop(dataTransferFor([a]), [
      knownFolder(persisted, false),
    ]);

    expect(resolution).toMatchObject({ kind: 'mounted', alreadyOpen: false, filePaths: ['a.dng'] });
    expect(picker()).not.toHaveBeenCalled();
  });

  it('seeds a directory picker at the file when no known folder contains it, then mounts on confirm', async () => {
    restoreBackend = withFsAccessBackend();
    const service = new FolderAccessService();
    const a = fileHandle('a.dng');
    const picked = dirHandle('NewRoll', { resolveMap: { 'a.dng': ['a.dng'] } });
    picker().mockResolvedValue(picked);

    const resolution = await service.resolveDrop(dataTransferFor([a]), []);

    expect(picker()).toHaveBeenCalledWith(expect.objectContaining({ startIn: a }));
    expect(resolution).toMatchObject({ kind: 'mounted', alreadyOpen: false, filePaths: ['a.dng'] });
  });

  it('treats picker cancellation for a loose file as cancelled, not a copy', async () => {
    restoreBackend = withFsAccessBackend();
    const service = new FolderAccessService();
    const a = fileHandle('a.dng');
    picker().mockRejectedValue(new DOMException('Cancelled', 'AbortError'));

    const resolution = await service.resolveDrop(dataTransferFor([a]), []);

    expect(resolution).toEqual({ kind: 'cancelled' });
  });

  it('falls back to copy when the confirmed folder does not actually contain the dropped file', async () => {
    restoreBackend = withFsAccessBackend();
    const service = new FolderAccessService();
    const a = fileHandle('a.dng');
    const file = new File(['x'], 'a.dng');
    const wrongFolder = dirHandle('WrongPlace', { resolveMap: {} });
    picker().mockResolvedValue(wrongFolder);

    const resolution = await service.resolveDrop(dataTransferFor([a], [file]), []);

    expect(resolution).toMatchObject({ kind: 'copy-fallback' });
  });

  it('falls back to copy when a mix of a folder and loose files is dropped', async () => {
    restoreBackend = withFsAccessBackend();
    const service = new FolderAccessService();
    const dir = dirHandle('Vacation');
    const file = fileHandle('loose.dng');

    const resolution = await service.resolveDrop(dataTransferFor([dir, file]), []);

    expect(resolution).toMatchObject({ kind: 'copy-fallback' });
  });

  it('falls back to copy when a dropped item cannot be resolved to a handle', async () => {
    restoreBackend = withFsAccessBackend();
    const service = new FolderAccessService();
    const dropFiles = [new File(['x'], 'a.dng')];

    const resolution = await service.resolveDrop(dataTransferFor([null], dropFiles), []);

    expect(resolution).toMatchObject({ kind: 'copy-fallback', files: dropFiles });
  });
});
