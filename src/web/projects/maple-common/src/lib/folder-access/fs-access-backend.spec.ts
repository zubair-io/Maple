import {
  fsAccessOpenDroppedFolder,
  fsAccessOpenFolder,
  fsAccessReopenHandle,
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
