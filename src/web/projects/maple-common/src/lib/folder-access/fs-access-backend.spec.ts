import { fsAccessOpenDroppedFolder } from './fs-access-backend';

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
});
