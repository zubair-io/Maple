import { test, expect } from 'bun:test';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import vectors from '../../../test-fixtures/ids/parser.json';
import * as api from '../src/indexer/id.ts';
import * as web from '../../web/projects/maple-common/src/lib/addressing/maple-id.ts';

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

test('70,001-byte golden preserves primary, browser full-file fallback and legacy server head-only fallback', async () => {
  const bytes = Uint8Array.from({ length: 70001 }, (_, i) => i % 251);
  for (const implementation of [api, web]) {
    expect(implementation.primary(bytes, '2024:06:01 12:34:56', 'SN-1234', 4242).hex).toBe(
      '01102ecbacd47a8405c6ed25cac58f85',
    );
    expect(implementation.fallback(bytes, bytes.length).hex).toBe(
      '020cd7e09e4485130fa4e571188060f1',
    );
  }
  const dir = await mkdtemp(join(tmpdir(), 'maple-id-golden-'));
  try {
    const file = join(dir, 'original.bin');
    await writeFile(file, bytes);
    expect((await api.hashFileForId(file)).maple_id).toBe('02cb7b06150dc8846a51af1abdba0f66');
    expect(new Uint8Array(await readFile(file))).toEqual(bytes);
  } finally {
    await rm(dir, { recursive: true });
  }
});
