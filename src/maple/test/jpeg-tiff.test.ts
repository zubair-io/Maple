/** #3591: committed Sharp pixel oracles exercise the real native backends. */
import { expect, test } from 'bun:test';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { maple } from '../src/index.ts';
import { maple as publishedMaple } from '../dist/index.js';

const root = fileURLToPath(new URL('../../../test-fixtures/jpeg-tiff/', import.meta.url));
const cases = [
  ['strips', 73, 273],
  ['tiles', 67, 45],
  ['bigtiff', 67, 45],
  ['quality40', 31, 27],
  ['quality95', 31, 27],
  ['orientation6', 31, 27],
] as const;

function expectPixels(actual: Uint8Array, expected: Uint8Array): void {
  expect(actual.length).toBe(expected.length);
  const differences = actual.map((value, i) => Math.abs(value - expected[i]));
  expect(Math.max(...differences)).toBeLessThanOrEqual(4);
  expect(
    differences.reduce((sum, value) => sum + value, 0) / differences.length,
  ).toBeLessThanOrEqual(0.5);
}

for (const [name, width, height] of cases) {
  test(`decodes and transcodes Sharp's ${name} JPEG TIFF`, async () => {
    const source = Buffer.from(await Bun.file(join(root, `${name}.tiff`)).arrayBuffer());
    const expected = new Uint8Array(await Bun.file(join(root, `${name}.rgb`)).arrayBuffer());
    for (const create of [maple, publishedMaple]) {
      const output = await create(source).toRaw();
      expect([output.width, output.height, output.channels]).toEqual([width, height, 3]);
      expectPixels(output.data, expected);
      const png = await create(source).png().toBuffer();
      const decoded = await create(png).toRaw();
      expect(decoded.data).toEqual(output.data);
      const resized = await create(source).resize(13).png().toBuffer();
      expect((await create(resized).metadata()).width).toBe(13);
    }
  });
}

test('honours TIFF orientation when requested without baking it into the default pixels', async () => {
  const source = Buffer.from(await Bun.file(join(root, 'orientation6.tiff')).arrayBuffer());
  const expected = new Uint8Array(
    await Bun.file(join(root, 'orientation6.rotated.rgb')).arrayBuffer(),
  );
  expect((await maple(source).metadata()).orientation).toBe(6);
  const rotated = await maple(source).rotate().toRaw();
  expect([rotated.width, rotated.height, rotated.channels]).toEqual([27, 31, 3]);
  expectPixels(rotated.data, expected);
});

test('processes a file-backed TIFF without modifying the original', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'maple-jpeg-tiff-'));
  try {
    const bytes = await Bun.file(join(root, 'tiles.tiff')).arrayBuffer();
    const input = join(directory, 'original.tiff');
    await writeFile(input, Buffer.from(bytes));
    const before = await stat(input);
    await maple(input).resize(13).jpeg().toBuffer();
    expect(await Bun.file(input).arrayBuffer()).toEqual(bytes);
    expect((await stat(input)).mtimeMs).toBe(before.mtimeMs);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
