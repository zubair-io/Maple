import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from '../fs/mirrored.ts';
import os from 'node:os';
import path from 'node:path';
import { maple } from 'maple';
import { solidPng } from '../test-support/synth-image.ts';
import { CROP_MARK_KEYWORD, markPngWithCrop } from './pano-png-crop-mark.ts';

let dir = '';
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'crop-mark-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const RECT = { x: 3, y: 4, width: 20, height: 10 };

describe('markPngWithCrop', () => {
  it('adds a tEXt chunk before IEND and leaves the PNG decodable with the same pixels', async () => {
    const file = path.join(dir, 'pano.png');
    const original = await solidPng(32, 16, [10, 20, 30]);
    await writeFile(file, original);

    await markPngWithCrop(file, RECT);

    const marked = await readFile(file);
    expect(marked.equals(original)).toBe(false);
    expect(marked.subarray(marked.length - 12).toString('hex')).toBe('0000000049454e44ae426082');
    expect(marked.includes(Buffer.from(`${CROP_MARK_KEYWORD}\0${3},${4},${20},${10}`))).toBe(true);
    const before = await maple(original).toRaw();
    const after = await maple(marked).toRaw();
    expect(after.width).toBe(before.width);
    expect(Buffer.from(after.data).equals(Buffer.from(before.data))).toBe(true);
  });

  it('computes the CRC the PNG specification does', () => {
    expect(Bun.hash.crc32(Buffer.from('IEND'))).toBe(0xae426082);
  });

  it('writes a chunk whose CRC covers its type and data', async () => {
    const file = path.join(dir, 'pano.png');
    await writeFile(file, await solidPng(8, 8, [0, 0, 0]));
    await markPngWithCrop(file, RECT);
    const bytes = await readFile(file);
    const at = bytes.indexOf('tEXt') - 4;
    const length = bytes.readUInt32BE(at);
    const body = bytes.subarray(at + 4, at + 8 + length);
    expect(bytes.readUInt32BE(at + 8 + length)).toBe(Bun.hash.crc32(body));
  });

  it('refuses a file that does not end like a PNG', async () => {
    const file = path.join(dir, 'broken.png');
    await writeFile(file, Buffer.from('not a png at all, not even a little bit'));
    await expect(markPngWithCrop(file, RECT)).rejects.toThrow('IEND');
  });
});
