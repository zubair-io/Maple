import { test, expect } from 'bun:test';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import vectors from '../../../test-fixtures/ids/parser.json';
import * as api from '../src/indexer/id.ts';
import { readExif } from '../src/indexer/exif.ts';
import * as web from '../../web/projects/maple-common/src/lib/addressing/maple-id-parser.ts';

for (const [name, implementation] of Object.entries({ api, web })) {
  test(`${name}: shared parser contract`, () => {
    for (const value of vectors.valid) {
      const id = implementation.fromHex(value);
      expect(id.hex).toBe(value.toLowerCase());
      expect(Buffer.from(id.bytes).toString('hex')).toBe(id.hex);
    }
    for (const value of vectors.invalid) expect(() => implementation.fromHex(value)).toThrow();
  });
}

test('70,001-byte golden preserves primary and the full-file fallback on the server, browser and native paths', async () => {
  const bytes = Uint8Array.from({ length: 70001 }, (_, i) => i % 251);
  expect(api.primary(bytes, '2024:06:01 12:34:56', 'SN-1234', 4242).hex).toBe(
    '01102ecbacd47a8405c6ed25cac58f85',
  );
  expect(api.fallback(bytes, bytes.length).hex).toBe('020cd7e09e4485130fa4e571188060f1');
  const dir = await mkdtemp(join(tmpdir(), 'maple-id-golden-'));
  try {
    const file = join(dir, 'original.bin');
    await writeFile(file, bytes);
    expect((await api.hashFileForId(file)).maple_id).toBe('020cd7e09e4485130fa4e571188060f1');
    expect(new Uint8Array(await readFile(file))).toEqual(bytes);
  } finally {
    await rm(dir, { recursive: true });
  }
});

// #5001: a dated QuickTime file. The server reads the creationdate key (it
// wins over mvhd, and its offset is converted to UTC) and hashes the primary
// form; the device reader (VideoCaptureDate.swift) and raw-core pin the same
// date and id from this same file.
test('dated-video golden: QuickTime creationdate drives the primary id', async () => {
  const path = new URL('../../../test-fixtures/ids/dated-video.mov', import.meta.url).pathname;
  const exif = await readExif(path);
  expect(exif?.captured_at).toBe('2026-04-05T18:26:20.000Z');
  const bytes = new Uint8Array(await readFile(path));
  expect(api.primary(bytes, exif!.captured_at!, null, null).hex).toBe(
    '01b176338229c1cb8b9ddfc6235e829d',
  );
});

test('placeholder original-date stills: the server falls back to CreateDate or rolls the zero date', async () => {
  const goldens = {
    'still-blank-original-date.jpg': [
      '2024-06-01T12:34:56.000Z',
      '01b070aac318b20a45cf629b2d2f1709',
    ],
    'still-zero-original-date.jpg': [
      '1899-11-30T00:00:00.000Z',
      '012f4ad811f9fb08900967db02879d0d',
    ],
  };
  for (const [name, [capturedAt, id]] of Object.entries(goldens)) {
    const file = join(import.meta.dir, '../../../test-fixtures/ids', name);
    const exif = await readExif(file);
    expect(exif?.captured_at).toBe(capturedAt);
    const head = new Uint8Array(await readFile(file)).subarray(0, 65536);
    expect(api.deriveId(head, capturedAt, null, null).hex).toBe(id);
  }
});
