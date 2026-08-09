import {
  fsAccessOpenDroppedFolder,
  fsAccessOpenFolder,
  fsAccessPickContainingFolder,
  fsAccessReopenHandle,
  fsAccessResolveCommonParent,
} from './fs-access-backend';

describe('fsAccessOpenFolder', () => {
  const original = Object.getOwnPropertyDescriptor(window, 'showDirectoryPicker');

  afterEach(() => {
    if (original) Object.defineProperty(window, 'showDirectoryPicker', original);
    else Reflect.deleteProperty(window, 'showDirectoryPicker');
  });

  it('treats picker cancellation as a no-op', async () => {
    Object.defineProperty(window, 'showDirectoryPicker', {
      configurable: true,
      value: vi.fn().mockRejectedValue(new DOMException('Cancelled', 'AbortError')),
    });

    await expect(fsAccessOpenFolder()).resolves.toBeNull();
  });

  it('keeps picker permission denial distinct from cancellation', async () => {
    Object.defineProperty(window, 'showDirectoryPicker', {
      configurable: true,
      value: vi.fn().mockRejectedValue(new DOMException('Denied', 'NotAllowedError')),
    });

    await expect(fsAccessOpenFolder()).rejects.toMatchObject({
      failure: 'permission-denied',
      inputName: 'the selected folder',
    });
  });
});

describe('fsAccessOpenDroppedFolder', () => {
  it('normalizes a dropped directory handle with write permission', async () => {
    const native = {
      kind: 'directory',
      name: 'raws',
      queryPermission: vi.fn().mockResolvedValue('granted'),
      requestPermission: vi.fn(),
    } as unknown as FileSystemDirectoryHandle;

    const folder = await fsAccessOpenDroppedFolder(native);

    expect(folder).toMatchObject({
      name: 'raws',
      read: true,
      write: true,
      native,
    });
  });

  it('rejects a denied dropped folder with its name and recovery action', async () => {
    const native = {
      kind: 'directory',
      name: 'Client RAWs',
      queryPermission: vi.fn().mockResolvedValue('denied'),
      requestPermission: vi.fn().mockResolvedValue('denied'),
    } as unknown as FileSystemDirectoryHandle;

    await expect(fsAccessOpenDroppedFolder(native)).rejects.toMatchObject({
      name: 'FolderAccessError',
      failure: 'permission-denied',
      inputName: 'Client RAWs',
      message: expect.stringContaining('Choose the folder again'),
    });
  });

  it('normalizes a permission API exception into the same named error', async () => {
    const native = {
      kind: 'directory',
      name: 'Archive',
      queryPermission: vi.fn().mockRejectedValue(new DOMException('revoked', 'NotAllowedError')),
      requestPermission: vi.fn(),
    } as unknown as FileSystemDirectoryHandle;

    await expect(fsAccessOpenDroppedFolder(native)).rejects.toMatchObject({
      failure: 'permission-denied',
      inputName: 'Archive',
    });
  });

  it('names permission loss when a persisted handle is reopened', async () => {
    const native = {
      kind: 'directory',
      name: 'Reloaded RAWs',
      queryPermission: vi.fn().mockResolvedValue('denied'),
      requestPermission: vi.fn().mockResolvedValue('denied'),
    } as unknown as FileSystemDirectoryHandle;

    await expect(
      fsAccessReopenHandle({ key: 'folder-1', name: native.name, handle: native, accessedAt: 1 }),
    ).rejects.toMatchObject({
      failure: 'permission-denied',
      inputName: 'Reloaded RAWs',
    });
  });
});

describe('fsAccessResolveCommonParent', () => {
  function fileHandle(name: string): FileSystemFileHandle {
    return { kind: 'file', name } as unknown as FileSystemFileHandle;
  }

  function dirHandle(
    name: string,
    opts: {
      resolveMap?: Record<string, string[] | null>;
      children?: Record<string, FileSystemDirectoryHandle>;
    } = {},
  ): FileSystemDirectoryHandle {
    const resolveMap = opts.resolveMap ?? {};
    const children = opts.children ?? {};
    return {
      kind: 'directory',
      name,
      resolve: vi.fn(async (h: FileSystemHandle) => resolveMap[h.name] ?? null),
      getDirectoryHandle: vi.fn(async (segment: string) => {
        const child = children[segment];
        if (!child) throw new Error(`no such directory: ${segment}`);
        return child;
      }),
    } as unknown as FileSystemDirectoryHandle;
  }

  it('returns the root itself when every file is a direct child', async () => {
    const a = fileHandle('a.dng');
    const b = fileHandle('b.dng');
    const root = dirHandle('Library', {
      resolveMap: { 'a.dng': ['a.dng'], 'b.dng': ['b.dng'] },
    });

    await expect(fsAccessResolveCommonParent(root, [a, b])).resolves.toEqual({
      dir: root,
      fileNames: ['a.dng', 'b.dng'],
    });
  });

  it("descends through every intermediate directory to reach a nested file's immediate parent", async () => {
    const nested = fileHandle('IMG_1.dng');
    const trip = dirHandle('Trip');
    const year = dirHandle('2024', { children: { Trip: trip } });
    const root = dirHandle('Library', {
      resolveMap: { 'IMG_1.dng': ['2024', 'Trip', 'IMG_1.dng'] },
      children: { '2024': year },
    });

    await expect(fsAccessResolveCommonParent(root, [nested])).resolves.toEqual({
      dir: trip,
      fileNames: ['IMG_1.dng'],
    });
  });

  it('returns null when the files are not siblings (no single common immediate parent)', async () => {
    const inYear = fileHandle('a.dng');
    const atRoot = fileHandle('b.dng');
    const root = dirHandle('Library', {
      resolveMap: { 'a.dng': ['2024', 'a.dng'], 'b.dng': ['b.dng'] },
      children: { '2024': dirHandle('2024') },
    });

    await expect(fsAccessResolveCommonParent(root, [inYear, atRoot])).resolves.toBeNull();
  });

  it('returns null when a file is not under the root at all', async () => {
    const outside = fileHandle('outside.dng');
    const root = dirHandle('Library', { resolveMap: {} });

    await expect(fsAccessResolveCommonParent(root, [outside])).resolves.toBeNull();
  });
});

describe('fsAccessPickContainingFolder', () => {
  const original = Object.getOwnPropertyDescriptor(window, 'showDirectoryPicker');

  afterEach(() => {
    if (original) Object.defineProperty(window, 'showDirectoryPicker', original);
    else Reflect.deleteProperty(window, 'showDirectoryPicker');
  });

  it('uses its own picker id, distinct from "Open folder", so a remembered directory for that id cannot override startIn', async () => {
    const showDirectoryPicker = vi.fn().mockResolvedValue({ kind: 'directory', name: 'Roll' });
    Object.defineProperty(window, 'showDirectoryPicker', {
      configurable: true,
      value: showDirectoryPicker,
    });
    const startIn = { kind: 'file', name: 'a.dng' } as unknown as FileSystemHandle;

    await fsAccessPickContainingFolder(startIn);

    expect(showDirectoryPicker).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'maple-drop-seed', startIn }),
    );
    expect(showDirectoryPicker.mock.calls[0][0].id).not.toBe('maple-folder');
  });
});
