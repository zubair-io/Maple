/**
 * A Replace never overwrites a file another writer put at the destination
 * after the displaced photo was kept and before the swap (#5141): it aborts
 * instead, the writer's file stays, and nothing hidden is left behind. Real
 * files in a temp dir; the writer lands at the exact step that precedes the
 * swap.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from './mirrored.ts';
import { relocateFile } from './relocate.ts';

let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'relocate-replace-writer-'));
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

const replace = () =>
  relocateFile({
    sourceAbsPath: abs('src/IMG.HEIC'),
    destAbsPath: abs('dst/IMG.HEIC'),
    mode: 'move',
    collision: 'replace',
  });

/** Another process saves a new file over the destination, the way an editor
 * or sync client does: write beside it, then rename into place. */
async function writerReplacesDestination(): Promise<void> {
  await fs.writeFile(abs('dst/IMG.HEIC.writer'), 'writer');
  await fs.rename(abs('dst/IMG.HEIC.writer'), abs('dst/IMG.HEIC'));
}

describe('Replace against a concurrent writer (#5141)', () => {
  test('a writer replacing the kept occupant is never overwritten', async () => {
    await write('src/IMG.HEIC', 'new');
    await write('dst/IMG.HEIC', 'old');
    const realLink = fs.link;
    const link = spyOn(fs, 'link').mockImplementation(async (existing, created) => {
      await realLink(existing, created);
      await writerReplacesDestination();
    });
    try {
      const outcome = await replace();
      expect(outcome.kind).toBe('error');
    } finally {
      link.mockRestore();
    }

    expect(await read('dst/IMG.HEIC')).toBe('writer');
    expect(await read('src/IMG.HEIC')).toBe('new');
    expect((await fs.readdir(abs('dst'))).sort()).toEqual(['IMG.HEIC']);
  });

  test('a writer modifying the kept occupant in place is never overwritten', async () => {
    await write('src/IMG.HEIC', 'new');
    await write('dst/IMG.HEIC', 'old');
    const realLink = fs.link;
    const link = spyOn(fs, 'link').mockImplementation(async (existing, created) => {
      await realLink(existing, created);
      await fs.appendFile(abs('dst/IMG.HEIC'), ' and more');
    });
    try {
      expect((await replace()).kind).toBe('error');
    } finally {
      link.mockRestore();
    }

    expect(await read('dst/IMG.HEIC')).toBe('old and more');
    expect(await read('src/IMG.HEIC')).toBe('new');
    expect((await fs.readdir(abs('dst'))).sort()).toEqual(['IMG.HEIC']);
  });

  test('where hard links are refused, a writer landing during the copy is never overwritten', async () => {
    await write('src/IMG.HEIC', 'new');
    await write('dst/IMG.HEIC', 'old');
    const realCopy = fs.copyFile;
    const link = spyOn(fs, 'link').mockRejectedValue(
      Object.assign(new Error('cross-device link'), { code: 'EXDEV' }),
    );
    const copy = spyOn(fs, 'copyFile').mockImplementation(async (from, to, mode) => {
      await realCopy(from, to, mode);
      if (from === abs('dst/IMG.HEIC')) await writerReplacesDestination();
    });
    try {
      expect((await replace()).kind).toBe('error');
    } finally {
      copy.mockRestore();
      link.mockRestore();
    }

    expect(await read('dst/IMG.HEIC')).toBe('writer');
    expect(await read('src/IMG.HEIC')).toBe('new');
    expect((await fs.readdir(abs('dst'))).sort()).toEqual(['IMG.HEIC']);
  });

  test('a writer creating a destination that was empty is never overwritten', async () => {
    await write('src/IMG.HEIC', 'new');
    await fs.mkdir(abs('dst'), { recursive: true });
    const realLink = fs.link;
    const link = spyOn(fs, 'link').mockImplementation(async (existing, created) => {
      try {
        await realLink(existing, created);
      } finally {
        await write('dst/IMG.HEIC', 'writer');
      }
    });
    try {
      expect((await replace()).kind).toBe('error');
    } finally {
      link.mockRestore();
    }

    expect(await read('dst/IMG.HEIC')).toBe('writer');
    expect(await read('src/IMG.HEIC')).toBe('new');
    expect((await fs.readdir(abs('dst'))).sort()).toEqual(['IMG.HEIC']);
  });

  test('a Replace nobody races still swaps the photo', async () => {
    await write('src/IMG.HEIC', 'new');
    await write('dst/IMG.HEIC', 'old');

    expect((await replace()).kind).toBe('relocated');

    expect(await read('dst/IMG.HEIC')).toBe('new');
    expect((await fs.readdir(abs('dst'))).sort()).toEqual(['IMG.HEIC']);
  });
});
