import { maple } from '../../../src/maple/src/index.ts';
import { mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

const out = new URL('./', import.meta.url);
await mkdir(out, { recursive: true });
const pixels = (width: number, height: number, channels: 3 | 4) => {
  const data = new Uint8Array(width * height * channels);
  for (let i = 0; i < width * height; i++) {
    data.set(channels === 4 ? [90, 140, 200, 127] : [90, 140, 200], i * channels);
  }
  return { data, width, height, channels };
};
const rows = [];
for (const profile of ['srgb', 'p3'] as const) {
  for (const channels of [3, 4] as const) {
    const name = `${profile}-${channels === 3 ? 'rgb' : 'rgba'}.avif`;
    const bytes = await maple(pixels(20, 10, channels))
      .withIccProfile(profile)
      .avif({ effort: 1 })
      .toBuffer();
    await writeFile(new URL(name, out), bytes);
    rows.push({
      name,
      bytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    });
  }
}
const oversized = await maple(pixels(300, 50, 3))
  .withIccProfile('srgb')
  .avif({ effort: 1 })
  .toBuffer();
await writeFile(new URL('oversized-srgb.avif', out), oversized);
rows.push({
  name: 'oversized-srgb.avif',
  bytes: oversized.length,
  sha256: createHash('sha256').update(oversized).digest('hex'),
});
const png = await maple(pixels(20, 10, 3))
  .withIccProfile('srgb')
  .png()
  .toBuffer();
const kept = await maple(png).withMetadata().avif({ effort: 1 }).toBuffer();
await writeFile(new URL('kept-srgb.avif', out), kept);
rows.push({
  name: 'kept-srgb.avif',
  bytes: kept.length,
  sha256: createHash('sha256').update(kept).digest('hex'),
});
console.log(JSON.stringify(rows, null, 2));
