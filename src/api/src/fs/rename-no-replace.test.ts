/**
 * The no-replace publication behind a sidecar upload on a volume without hard
 * links (#5143). Real files in a temp dir; the outside writer is a separate
 * process, so it is genuinely not under the API's save barrier. Run with
 * `TMPDIR` on an SMB mount to exercise the same tests on that volume.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from './mirrored.ts';
import { publishWholeExclusive } from './publish-whole.ts';
import * as noReplace from './rename-no-replace.ts';
import { PublishCollisionError } from './relocate-publish.ts';

let root: string;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'rename-no-replace-'));
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

const abs = (name: string) => path.join(root, name);
const read = (name: string) => fs.readFile(abs(name), 'utf8').catch(() => null);

const OUTSIDE_WRITER = `
import { writeFileSync } from 'node:fs';
writeFileSync(process.argv[2], 'FOREIGN');
`;

/** Another process writes `name` straight onto the volume, then exits. */
async function outsideWriterCreates(name: string): Promise<void> {
  const script = abs('outside-writer.ts');
  await fs.writeFile(script, OUTSIDE_WRITER);
  const child = Bun.spawn([process.execPath, script, abs(name)]);
  expect(await child.exited).toBe(0);
}

/** The outside writer lands right after the publisher's `stat` of the folder, before it renames. */
function writerLandsAfterStat(name: string) {
  const realStat = fs.stat;
  return spyOn(fs, 'stat').mockImplementation((async (file: string) => {
    const result = await realStat(file);
    await outsideWriterCreates(name);
    return result;
  }) as typeof fs.stat);
}

const refuseLinks = () =>
  spyOn(fs, 'link').mockRejectedValue(
    Object.assign(new Error('operation not supported'), { code: 'ENOTSUP' }),
  );

describe('renameNoReplace', () => {
  test('renames onto an absent name', async () => {
    await fs.writeFile(abs('a.tmp'), 'ours');
    const outcome = await noReplace.renameNoReplace(abs('a.tmp'), abs('a.xmp'));
    if (outcome === 'unsupported') return;
    expect(await read('a.xmp')).toBe('ours');
    expect(await read('a.tmp')).toBeNull();
  });

  test('refuses an occupied name and leaves both files alone', async () => {
    await fs.writeFile(abs('a.tmp'), 'ours');
    await fs.writeFile(abs('a.xmp'), 'theirs');
    const outcome = await noReplace
      .renameNoReplace(abs('a.tmp'), abs('a.xmp'))
      .catch((err: unknown) => err);
    if (outcome === 'unsupported') return;
    expect(outcome).toBeInstanceOf(PublishCollisionError);
    expect(await read('a.xmp')).toBe('theirs');
    expect(await read('a.tmp')).toBe('ours');
  });

  test('a writer outside the API landing right before the rename is never replaced', async () => {
    await fs.writeFile(abs('a.tmp'), 'ours');
    const stat = writerLandsAfterStat('a.xmp');
    let outcome: unknown;
    try {
      outcome = await noReplace
        .renameNoReplace(abs('a.tmp'), abs('a.xmp'))
        .catch((e: unknown) => e);
    } finally {
      stat.mockRestore();
    }
    if (outcome === 'unsupported') return;
    expect(outcome).toBeInstanceOf(PublishCollisionError);
    expect(await read('a.xmp')).toBe('FOREIGN');
  });
});

describe('publishWholeExclusive where hard links are refused', () => {
  test('publishes an absent name whole', async () => {
    await fs.writeFile(abs('a.tmp'), 'ours');
    const link = refuseLinks();
    try {
      await publishWholeExclusive(abs('a.tmp'), abs('a.xmp'));
    } finally {
      link.mockRestore();
    }
    expect(await read('a.xmp')).toBe('ours');
  });

  test('never replaces a writer that took the name, whichever step finds it', async () => {
    for (const unsupported of [false, true]) {
      await fs.writeFile(abs('b.tmp'), 'ours');
      await fs.rm(abs('b.xmp'), { force: true });
      const link = refuseLinks();
      const rename = unsupported
        ? spyOn(noReplace, 'renameNoReplace').mockImplementation(async () => {
            await outsideWriterCreates('b.xmp');
            return 'unsupported';
          })
        : null;
      const stat = unsupported ? null : writerLandsAfterStat('b.xmp');
      let outcome: unknown;
      try {
        outcome = await publishWholeExclusive(abs('b.tmp'), abs('b.xmp')).catch((e: unknown) => e);
      } finally {
        link.mockRestore();
        rename?.mockRestore();
        stat?.mockRestore();
      }
      expect(outcome).toBeInstanceOf(PublishCollisionError);
      expect(await read('b.xmp')).toBe('FOREIGN');
    }
  });

  test('a link that fails for another reason is not hidden', async () => {
    await fs.writeFile(abs('c.tmp'), 'ours');
    const link = spyOn(fs, 'link').mockRejectedValue(
      Object.assign(new Error('no space'), { code: 'ENOSPC' }),
    );
    try {
      await expect(publishWholeExclusive(abs('c.tmp'), abs('c.xmp'))).rejects.toMatchObject({
        code: 'ENOSPC',
      });
    } finally {
      link.mockRestore();
    }
    expect(await read('c.xmp')).toBeNull();
  });
});
