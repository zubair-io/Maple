import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtemp, open, rm, writeFile } from '../../fs/mirrored.ts';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileByteSource, SourceChangedError } from './byte-source.ts';

let dir = '';

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'maple-byte-source-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

test('reads stop at the 8 MB budget and never leave the file', async () => {
  const path = join(dir, 'big.bin');
  await writeFile(path, Buffer.alloc(9 * 1024 * 1024, 1));
  const handle = await open(path, 'r');
  try {
    const source = fileByteSource(handle, path, 9 * 1024 * 1024, new AbortController().signal);
    expect(await source.read(9 * 1024 * 1024 - 4, 8)).toBeNull();
    expect(await source.read(-1, 4)).toBeNull();
    expect((await source.read(0, 8 * 1024 * 1024 - 16))?.length).toBe(8 * 1024 * 1024 - 16);
    expect((await source.read(0, 16))?.length).toBe(16);
    expect(await source.read(0, 1)).toBeNull();
  } finally {
    await handle.close();
  }
});

test('a file truncated under the open handle throws for a retry', async () => {
  const path = join(dir, 'shrinking.bin');
  await writeFile(path, Buffer.alloc(4096, 1));
  const handle = await open(path, 'r');
  try {
    const source = fileByteSource(handle, path, 4096, new AbortController().signal);
    await writeFile(path, Buffer.alloc(100, 1));
    await expect(source.read(1024, 64)).rejects.toBeInstanceOf(SourceChangedError);
  } finally {
    await handle.close();
  }
});
