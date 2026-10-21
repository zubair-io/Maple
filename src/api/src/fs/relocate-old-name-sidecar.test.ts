/**
 * Relocate carries a photo's pre-#5021 `IMG.HEIC.xmp` (#5063) without ever
 * replacing another tool's file at the name it lands on. Real files in a temp dir.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from './mirrored.ts';
import { oldNameEditUnlisted } from './legacy-backup-sidecar.ts';
import { relocateFile } from './relocate.ts';

const maple = (label: string) =>
  `<x:xmpmeta xmlns:papp="http://ns.justmaple.app/photo/1.0/">${label}</x:xmpmeta>`;
const darktable = '<x:xmpmeta xmlns:darktable="http://darktable.sf.net/"/>';

/** A case-sensitive temp volume keeps `IMG.HEIC.xmp` and `img.heic.xmp` apart. */
async function caseSensitiveTmp(): Promise<boolean> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'case-probe-'));
  try {
    await fs.writeFile(path.join(dir, 'a'), '');
    return !(await fs.lstat(path.join(dir, 'A')).then(
      () => true,
      () => false,
    ));
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}
const caseSensitive = await caseSensitiveTmp();

let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'relocate-old-name-'));
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

const abs = (rel: string) => path.join(root, ...rel.split('/'));
const read = (rel: string) => fs.readFile(abs(rel), 'utf8').catch(() => null);
async function write(rel: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(abs(rel)), { recursive: true });
  await fs.writeFile(abs(rel), content);
}

const move = (collision: 'replace' | 'auto-suffix') =>
  relocateFile({
    sourceAbsPath: abs('src/IMG.HEIC'),
    destAbsPath: abs('dst/IMG.HEIC'),
    mode: 'move',
    collision,
  });

describe('relocate — old-name backup edits (#5063)', () => {
  test("Replace never removes another tool's file where the old-name edit would land, and keeps the edit", async () => {
    await write('src/IMG.HEIC', 'new');
    await write('src/IMG.HEIC.xmp', maple('backup edit'));
    await write('dst/IMG.HEIC', 'old');
    await write('dst/IMG.HEIC.xmp', darktable);

    const outcome = await move('replace');

    expect(outcome.kind).toBe('relocated');
    expect(await read('dst/IMG.HEIC')).toBe('new');
    expect(await read('dst/IMG.HEIC.xmp')).toBe(darktable);
    expect(await read('src/IMG.HEIC.xmp')).toBe(maple('backup edit'));
  });

  test("Replace takes over the previous photo's old-name edit", async () => {
    await write('src/IMG.HEIC', 'new');
    await write('src/IMG.HEIC.xmp', maple('backup edit'));
    await write('dst/IMG.HEIC', 'old');
    await write('dst/IMG.HEIC.xmp', maple('previous edit'));

    const outcome = await move('replace');

    expect(outcome.kind).toBe('relocated');
    expect(await read('dst/IMG.HEIC.xmp')).toBe(maple('backup edit'));
  });

  test("auto-suffix moves past another tool's file at the old-name slot", async () => {
    await write('src/IMG.HEIC', 'new');
    await write('src/IMG.HEIC.xmp', maple('backup edit'));
    await write('dst/IMG.HEIC.xmp', darktable);

    const outcome = await move('auto-suffix');

    expect(outcome.kind).toBe('relocated');
    expect(await read('dst/IMG.HEIC.xmp')).toBe(darktable);
    expect(await read('dst/IMG.1.HEIC.xmp')).toBe(maple('backup edit'));
  });

  test("auto-suffix moves past another photo's stranded old-name edit", async () => {
    await write('src/IMG.HEIC', 'new');
    await write('dst/IMG.HEIC.xmp', maple('stranded edit'));

    const outcome = await move('auto-suffix');

    expect(outcome.kind).toBe('relocated');
    expect(await read('dst/IMG.1.HEIC')).toBe('new');
    expect(await read('dst/IMG.HEIC.xmp')).toBe(maple('stranded edit'));
  });

  test("Replace without a sidecar drops the previous photo's old-name edit", async () => {
    await write('src/IMG.HEIC', 'new');
    await write('dst/IMG.HEIC', 'old');
    await write('dst/IMG.HEIC.xmp', maple('previous edit'));

    const outcome = await move('replace');

    expect(outcome.kind).toBe('relocated');
    expect(await read('dst/IMG.HEIC.xmp')).toBeNull();
  });

  test("auto-suffix won't land the edit on a name another file there owns", async () => {
    await write('src/IMG.HEIC', 'new');
    await write('src/IMG.HEIC.xmp', maple('backup edit'));
    await write('dst/IMG.HEIC.JPG', 'export');

    const outcome = await move('auto-suffix');

    expect(outcome.kind).toBe('relocated');
    expect(await read('dst/IMG.HEIC.xmp')).toBeNull();
    expect(await read('dst/IMG.1.HEIC.xmp')).toBe(maple('backup edit'));
  });

  test("Replace never removes another file's own sidecar at that name, and keeps the edit", async () => {
    await write('src/IMG.HEIC', 'new');
    await write('src/IMG.HEIC.xmp', maple('backup edit'));
    await write('dst/IMG.HEIC', 'old');
    await write('dst/IMG.HEIC.JPG', 'export');
    await write('dst/IMG.HEIC.xmp', maple("the export's edit"));

    const outcome = await move('replace');

    expect(outcome.kind).toBe('relocated');
    expect(await read('dst/IMG.HEIC.xmp')).toBe(maple("the export's edit"));
    expect(await read('src/IMG.HEIC.xmp')).toBe(maple('backup edit'));
  });

  test("Replace drops the previous photo's old-name edit when the incoming one brings only its own sidecar", async () => {
    await write('src/IMG.HEIC', 'new');
    await write('src/IMG.xmp', maple('incoming edit'));
    await write('dst/IMG.HEIC', 'old');
    await write('dst/IMG.HEIC.xmp', maple('previous edit'));

    const outcome = await move('replace');

    expect(outcome.kind).toBe('relocated');
    expect(await read('dst/IMG.xmp')).toBe(maple('incoming edit'));
    expect(await read('dst/IMG.HEIC.xmp')).toBeNull();
  });

  test('a move to a name with no extension still succeeds and leaves the old-name edit behind', async () => {
    await write('src/IMG.HEIC', 'new');
    await write('src/IMG.xmp', maple('server edit'));
    await write('src/IMG.HEIC.xmp', maple('backup edit'));

    const outcome = await relocateFile({
      sourceAbsPath: abs('src/IMG.HEIC'),
      destAbsPath: abs('dst/Trip'),
      mode: 'move',
      collision: 'auto-suffix',
    });

    expect(outcome.kind).toBe('relocated');
    expect(await read('dst/Trip.xmp')).toBe(maple('server edit'));
    expect(await read('src/IMG.HEIC.xmp')).toBe(maple('backup edit'));
  });

  test('a copy carries the old-name edit onto the copy and keeps the original', async () => {
    await write('src/IMG.HEIC', 'new');
    await write('src/IMG.HEIC.xmp', maple('backup edit'));

    const outcome = await relocateFile({
      sourceAbsPath: abs('src/IMG.HEIC'),
      destAbsPath: abs('dst/IMG.HEIC'),
      mode: 'copy',
      collision: 'auto-suffix',
    });

    expect(outcome.kind).toBe('relocated');
    expect(await read('dst/IMG.HEIC.xmp')).toBe(maple('backup edit'));
    expect(await read('src/IMG.HEIC.xmp')).toBe(maple('backup edit'));
  });

  test("Replace with no photo there keeps another photo's stranded old-name edit", async () => {
    await write('src/IMG.HEIC', 'new');
    await write('src/IMG.xmp', maple('incoming edit'));
    await write('dst/IMG.HEIC.xmp', maple('stranded edit'));

    const outcome = await move('replace');

    expect(outcome.kind).toBe('relocated');
    expect(await read('dst/IMG.HEIC.xmp')).toBe(maple('stranded edit'));
  });

  test("Replace without sidecars and no photo there keeps another photo's stranded old-name edit", async () => {
    await write('src/IMG.HEIC', 'new');
    await write('dst/IMG.HEIC.xmp', maple('stranded edit'));

    const outcome = await move('replace');

    expect(outcome.kind).toBe('relocated');
    expect(await read('dst/IMG.HEIC.xmp')).toBe(maple('stranded edit'));
  });

  test('Replace onto a stranded old-name edit with no photo there keeps both edits', async () => {
    await write('src/IMG.HEIC', 'new');
    await write('src/IMG.HEIC.xmp', maple('incoming edit'));
    await write('dst/IMG.HEIC.xmp', maple('stranded edit'));

    const outcome = await move('replace');

    expect(outcome.kind).toBe('relocated');
    expect(await read('dst/IMG.HEIC.xmp')).toBe(maple('stranded edit'));
    expect(await read('src/IMG.HEIC.xmp')).toBe(maple('incoming edit'));
  });

  // Root reads a mode-000 file anyway, so there is nothing to refuse.
  test.skipIf(process.getuid?.() === 0)(
    "a move refuses a photo whose old-name edit can't be read, instead of leaving it behind",
    async () => {
      await write('src/IMG.HEIC', 'new');
      await write('src/IMG.HEIC.xmp', maple('backup edit'));
      await fs.chmod(abs('src/IMG.HEIC.xmp'), 0o000);
      try {
        const outcome = await move('auto-suffix');

        expect(outcome.kind).toBe('error');
        expect(await read('src/IMG.HEIC')).toBe('new');
        expect(await read('dst/IMG.HEIC')).toBeNull();
      } finally {
        await fs.chmod(abs('src/IMG.HEIC.xmp'), 0o644);
      }
    },
  );

  // Root reads a mode-000 file anyway, so there is nothing to refuse.
  test.skipIf(process.getuid?.() === 0)(
    "Replace refuses before moving anything when the displaced photo's old-name edit can't be read",
    async () => {
      await write('src/IMG.HEIC', 'new');
      await write('src/IMG.xmp', maple('incoming edit'));
      await write('dst/IMG.HEIC', 'old');
      await write('dst/IMG.HEIC.xmp', maple('previous edit'));
      await fs.chmod(abs('dst/IMG.HEIC.xmp'), 0o000);
      try {
        const outcome = await move('replace');

        expect(outcome.kind).toBe('error');
        expect(await read('dst/IMG.HEIC')).toBe('old');
        expect(await read('src/IMG.HEIC')).toBe('new');
      } finally {
        await fs.chmod(abs('dst/IMG.HEIC.xmp'), 0o644);
      }
    },
  );
});

describe('relocate — unreadable and displaced old-name edits (#5063)', () => {
  test('a name with no room for an old-name file is not refused as unreadable', async () => {
    const name = `${'x'.repeat(250)}.HEIC`;
    await write(`src/${name}`, 'new');

    expect(await oldNameEditUnlisted(abs(`src/${name}`), [])).toBe(false);
  });

  // Root reads a mode-000 file anyway, so there is nothing to refuse.
  test.skipIf(process.getuid?.() === 0)(
    "a copy still goes ahead when the old-name edit can't be read; the original keeps it",
    async () => {
      await write('src/IMG.HEIC', 'new');
      await write('src/IMG.HEIC.xmp', maple('backup edit'));
      await fs.chmod(abs('src/IMG.HEIC.xmp'), 0o000);
      try {
        const outcome = await relocateFile({
          sourceAbsPath: abs('src/IMG.HEIC'),
          destAbsPath: abs('dst/IMG.HEIC'),
          mode: 'copy',
          collision: 'auto-suffix',
        });

        expect(outcome.kind).toBe('relocated');
        expect(await read('src/IMG.HEIC')).toBe('new');
      } finally {
        await fs.chmod(abs('src/IMG.HEIC.xmp'), 0o644);
      }
    },
  );

  // Root lists a directory without read permission anyway.
  test.skipIf(process.getuid?.() === 0)(
    "a move refuses when the photo's folder can't be listed but its old-name edit is there",
    async () => {
      await write('src/IMG.HEIC', 'new');
      await write('src/IMG.HEIC.xmp', maple('backup edit'));
      await fs.chmod(abs('src'), 0o311);
      try {
        const outcome = await move('auto-suffix');

        expect(outcome.kind).toBe('error');
      } finally {
        await fs.chmod(abs('src'), 0o755);
      }
      expect(await read('src/IMG.HEIC.xmp')).toBe(maple('backup edit'));
      expect(await read('dst/IMG.HEIC')).toBeNull();
    },
  );

  // Root lists a directory without read permission anyway.
  test.skipIf(process.getuid?.() === 0)(
    "another tool's full-name file in an unlistable folder doesn't block a move",
    async () => {
      await write('src/IMG.HEIC', 'new');
      await write('src/IMG.HEIC.xmp', darktable);
      await fs.chmod(abs('src'), 0o311);
      try {
        expect(await oldNameEditUnlisted(abs('src/IMG.HEIC'), [])).toBe(false);
      } finally {
        await fs.chmod(abs('src'), 0o755);
      }
    },
  );

  // Root reads a mode-000 file anyway, so there is nothing to refuse.
  test.skipIf(process.getuid?.() === 0)(
    "a move rolls back when the old-name edit can't be copied after all",
    async () => {
      await write('src/IMG.HEIC', 'new');
      await write('src/IMG.HEIC.xmp', maple('backup edit'));
      try {
        const outcome = await relocateFile({
          sourceAbsPath: abs('src/IMG.HEIC'),
          destAbsPath: abs('dst/IMG.HEIC'),
          mode: 'move',
          collision: 'auto-suffix',
          onDestinationPrepared: () => fs.chmod(abs('src/IMG.HEIC.xmp'), 0o000),
        });

        expect(outcome.kind).toBe('error');
        expect(await read('src/IMG.HEIC')).toBe('new');
        expect(await read('dst/IMG.HEIC')).toBeNull();
      } finally {
        await fs.chmod(abs('src/IMG.HEIC.xmp'), 0o644);
      }
    },
  );

  test('an old-name edit that vanishes mid-move (the migration took it) never fails Replace', async () => {
    await write('src/IMG.HEIC', 'new');
    await write('src/IMG.HEIC.xmp', maple('backup edit'));
    await write('dst/IMG.HEIC', 'old');
    await write('dst/IMG.xmp', maple('old edit'));

    const outcome = await relocateFile({
      sourceAbsPath: abs('src/IMG.HEIC'),
      destAbsPath: abs('dst/IMG.HEIC'),
      mode: 'move',
      collision: 'replace',
      onDestinationPrepared: () => fs.rm(abs('src/IMG.HEIC.xmp')),
    });

    expect(outcome.kind).toBe('relocated');
    expect(await read('dst/IMG.HEIC')).toBe('new');
  });

  // Root reads a mode-000 file anyway, so there is nothing to refuse.
  test.skipIf(process.getuid?.() === 0)(
    "Replace never loses the displaced photo over an old-name edit it can't copy",
    async () => {
      await write('src/IMG.HEIC', 'new');
      await write('src/IMG.HEIC.xmp', maple('backup edit'));
      await write('dst/IMG.HEIC', 'old');
      try {
        const outcome = await relocateFile({
          sourceAbsPath: abs('src/IMG.HEIC'),
          destAbsPath: abs('dst/IMG.HEIC'),
          mode: 'move',
          collision: 'replace',
          onDestinationPrepared: () => fs.chmod(abs('src/IMG.HEIC.xmp'), 0o000),
        });

        expect(outcome.kind).toBe('relocated');
        expect(await read('dst/IMG.HEIC')).toBe('new');
      } finally {
        await fs.chmod(abs('src/IMG.HEIC.xmp'), 0o644);
      }
      expect(await read('src/IMG.HEIC.xmp')).toBe(maple('backup edit'));
    },
  );

  test("Replace drops the displaced photo's old-name edit stored in another case", async () => {
    await write('src/IMG.HEIC', 'new');
    await write('src/IMG.xmp', maple('incoming edit'));
    await write('dst/IMG.HEIC', 'old');
    await write('dst/img.heic.xmp', maple('previous edit'));

    const outcome = await move('replace');

    expect(outcome.kind).toBe('relocated');
    expect(await read('dst/img.heic.xmp')).toBeNull();
    expect(await read('dst/IMG.HEIC.xmp')).toBeNull();
  });

  test.skipIf(process.getuid?.() === 0)(
    "Replace refuses when the displaced photo's old-name edit can't be read, even when the incoming photo brings one",
    async () => {
      await write('src/IMG.HEIC', 'new');
      await write('src/IMG.HEIC.xmp', maple('backup edit'));
      await write('dst/IMG.HEIC', 'old');
      await write('dst/IMG.HEIC.xmp', maple('previous edit'));
      await fs.chmod(abs('dst/IMG.HEIC.xmp'), 0o000);
      try {
        const outcome = await move('replace');

        expect(outcome.kind).toBe('error');
        expect(await read('dst/IMG.HEIC')).toBe('old');
        expect(await read('src/IMG.HEIC.xmp')).toBe(maple('backup edit'));
      } finally {
        await fs.chmod(abs('dst/IMG.HEIC.xmp'), 0o644);
      }
    },
  );

  test("Replace's incoming old-name edit takes over the displaced one stored in another case", async () => {
    await write('src/IMG.HEIC', 'new');
    await write('src/IMG.HEIC.xmp', maple('backup edit'));
    await write('dst/IMG.HEIC', 'old');
    await write('dst/img.heic.xmp', maple('previous edit'));

    const outcome = await move('replace');

    expect(outcome.kind).toBe('relocated');
    expect(await read('dst/IMG.HEIC.xmp')).toBe(maple('backup edit'));
    expect((await fs.readdir(abs('dst'))).sort()).toEqual(['IMG.HEIC', 'IMG.HEIC.xmp']);
    expect(await read('src/IMG.HEIC.xmp')).toBeNull();
  });

  test.skipIf(!caseSensitive)(
    "Replace retires the displaced edit in another case even when the incoming edit can't land",
    async () => {
      await write('src/IMG.HEIC', 'new');
      await write('src/IMG.HEIC.xmp', maple('backup edit'));
      await write('dst/IMG.HEIC', 'old');
      await write('dst/IMG.HEIC.xmp', darktable);
      await write('dst/img.heic.xmp', maple('previous edit'));

      const outcome = await move('replace');

      expect(outcome.kind).toBe('relocated');
      expect(await read('dst/img.heic.xmp')).toBeNull();
      expect(await read('dst/IMG.HEIC.xmp')).toBe(darktable);
      expect(await read('src/IMG.HEIC.xmp')).toBe(maple('backup edit'));
    },
  );

  test('Replace keeps a displaced old-name edit saved after the plan read it as a conflict copy', async () => {
    await write('src/IMG.HEIC', 'new');
    await write('src/IMG.xmp', maple('incoming edit'));
    await write('dst/IMG.HEIC', 'old');
    await write('dst/IMG.HEIC.xmp', maple('previous edit'));

    const outcome = await relocateFile({
      sourceAbsPath: abs('src/IMG.HEIC'),
      destAbsPath: abs('dst/IMG.HEIC'),
      mode: 'move',
      collision: 'replace',
      onDestinationPrepared: () => write('dst/IMG.HEIC.xmp', maple('saved meanwhile')),
    });

    expect(outcome.kind).toBe('relocated');
    expect(await read('dst/IMG.HEIC.xmp')).toBeNull();
    expect(await read('dst/IMG (conflict from move).xmp')).toBe(maple('saved meanwhile'));
  });

  test("Replace's takeover keeps a displaced old-name edit saved after the plan as a conflict copy", async () => {
    await write('src/IMG.HEIC', 'new');
    await write('src/IMG.HEIC.xmp', maple('backup edit'));
    await write('dst/IMG.HEIC', 'old');
    await write('dst/IMG.HEIC.xmp', maple('previous edit'));

    const outcome = await relocateFile({
      sourceAbsPath: abs('src/IMG.HEIC'),
      destAbsPath: abs('dst/IMG.HEIC'),
      mode: 'move',
      collision: 'replace',
      onDestinationPrepared: () => write('dst/IMG.HEIC.xmp', maple('saved meanwhile')),
    });

    expect(outcome.kind).toBe('relocated');
    expect(await read('dst/IMG.HEIC.xmp')).toBe(maple('backup edit'));
    expect(await read('dst/IMG (conflict from move).xmp')).toBe(maple('saved meanwhile'));
  });

  test.skipIf(!caseSensitive)(
    "Replace removes every spelling of the displaced photo's old-name edit",
    async () => {
      await write('src/IMG.HEIC', 'new');
      await write('dst/IMG.HEIC', 'old');
      await write('dst/IMG.HEIC.xmp', maple('previous edit'));
      await write('dst/img.heic.xmp', maple('previous edit, other spelling'));

      const outcome = await move('replace');

      expect(outcome.kind).toBe('relocated');
      expect(await read('dst/IMG.HEIC.xmp')).toBeNull();
      expect(await read('dst/img.heic.xmp')).toBeNull();
    },
  );

  test.skipIf(process.getuid?.() === 0 || !caseSensitive)(
    "Replace refuses when it can't list the destination to find a displaced edit in another case",
    async () => {
      await write('src/IMG.HEIC', 'new');
      await write('src/IMG.xmp', maple('incoming edit'));
      await write('dst/IMG.HEIC', 'old');
      await write('dst/img.heic.xmp', maple('previous edit'));
      await fs.chmod(abs('dst'), 0o311);
      try {
        const outcome = await move('replace');

        expect(outcome.kind).toBe('error');
      } finally {
        await fs.chmod(abs('dst'), 0o755);
      }
      expect(await read('dst/IMG.HEIC')).toBe('old');
      expect(await read('dst/img.heic.xmp')).toBe(maple('previous edit'));
    },
  );
});
