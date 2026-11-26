import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from '../fs/mirrored.ts';
import { childInspector, sharedGrant } from './folder-child.ts';

describe('childInspector', () => {
  let base = '';
  let library = '';

  beforeEach(async () => {
    base = await realpath(await mkdtemp(join(tmpdir(), 'maple-child-')));
    library = join(base, 'library');
    await mkdir(join(library, 'folder'), { recursive: true });
    await mkdir(join(base, 'outside'));
    await writeFile(join(library, 'a.jpg'), 'a');
    await writeFile(join(base, 'outside', 'secret.jpg'), 's');
    await symlink(join(library, 'a.jpg'), join(library, 'link.jpg'));
    await symlink(join(base, 'outside', 'secret.jpg'), join(library, 'escape.jpg'));
    await symlink(join(library, 'gone.jpg'), join(library, 'dangling.jpg'));
  });

  afterEach(async () => {
    await rm(base, { recursive: true, force: true });
  });

  it('answers a plain file or folder from one lstat, naming it under the real directory', async () => {
    const inspect = childInspector(library, library, library);
    expect(await inspect('a.jpg')).toMatchObject({ real: join(library, 'a.jpg'), direct: true });
    const folder = await inspect('folder');
    expect(folder?.direct).toBe(true);
    expect(folder?.stat.isDirectory()).toBe(true);
  });

  it('follows an in-library symlink to its target and its stat', async () => {
    const link = await childInspector(library, library, library)('link.jpg');
    expect(link).toMatchObject({ real: join(library, 'a.jpg'), direct: false });
    expect(link?.stat.isFile()).toBe(true);
  });

  it('rejects a symlink that leaves the library, a dangling one and a missing name', async () => {
    const inspect = childInspector(library, library, library);
    expect(await inspect('escape.jpg')).toBeNull();
    expect(await inspect('dangling.jpg')).toBeNull();
    expect(await inspect('missing.jpg')).toBeNull();
  });

  it('realpaths every child when the directory itself is not known to be inside the library', async () => {
    const inspect = childInspector(library, null, library);
    expect(await inspect('a.jpg')).toMatchObject({ real: join(library, 'a.jpg'), direct: false });
    expect(await inspect('escape.jpg')).toBeNull();
  });

  it('shares one answer per name', async () => {
    const inspect = childInspector(library, library, library);
    expect(inspect('a.jpg')).toBe(inspect('a.jpg'));
  });

  it.skipIf(process.platform !== 'darwin' || process.getuid?.() === 0)(
    'leaves out a plain child this process cannot open, as realpath did on macOS',
    async () => {
      await writeFile(join(library, 'locked.jpg'), 'l');
      await chmod(join(library, 'locked.jpg'), 0o000);
      await mkdir(join(library, 'sealed'));
      await chmod(join(library, 'sealed'), 0o311);
      const inspect = childInspector(library, library, library);
      try {
        expect(await inspect('locked.jpg')).toBeNull();
        expect(await inspect('sealed')).toBeNull();
        expect(await inspect('a.jpg')).not.toBeNull();
      } finally {
        await chmod(join(library, 'sealed'), 0o755);
      }
    },
  );
});

describe('sharedGrant', () => {
  it('asks once while the answer is a grant', async () => {
    const asked: string[] = [];
    const granted = sharedGrant(async (name: string) => {
      asked.push(name);
      return true;
    });
    expect(await Promise.all([granted('a'), granted('b'), granted('c')])).toEqual([
      true,
      true,
      true,
    ]);
    expect(asked).toEqual(['a']);
  });

  it('never shares a refusal or a failure: each caller is asked about its own argument', async () => {
    const asked: string[] = [];
    const granted = sharedGrant(async (name: string) => {
      asked.push(name);
      if (name === 'broken') throw new Error('roots unavailable');
      return name !== 'refused';
    });
    expect(await granted('refused')).toBe(false);
    await expect(granted('broken')).rejects.toThrow('roots unavailable');
    expect(await granted('b')).toBe(true);
    expect(await granted('c')).toBe(true);
    expect(asked).toEqual(['refused', 'refused', 'broken', 'broken', 'b']);
  });
});
