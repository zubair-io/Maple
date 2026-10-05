/** #3583: public-package AVIF rate/fidelity comparison; Sharp decodes both outputs. */
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { maple } from '../src/index.ts';
import { findNativeLib } from '../src/native-library.ts';
if (process.env.MAPLE_NAPI !== '0')
  throw new Error('Run with MAPLE_NAPI=0 to measure the identified Bun FFI library.');
const nativeLibrary = findNativeLib();
if (!nativeLibrary) throw new Error('Build the native library or set MAPLE_NATIVE_LIB.');
const require = createRequire(import.meta.url);
const sharp = require('sharp');
const width = 64,
  height = 64;
const source = new Uint8Array(width * height * 3);
let state = 7;
for (let y = 0; y < height; y++)
  for (let x = 0; x < width; x++) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    const noise = ((state >>> 22) & 31) - 16;
    const clamp = (v: number) => Math.max(0, Math.min(255, v));
    const i = (y * width + x) * 3;
    source[i] = clamp(x * 4 + noise);
    source[i + 1] = clamp(y * 4 + noise);
    source[i + 2] = clamp(128 + ((x + y) >> 1) + noise);
  }
async function inspect(bytes: Buffer) {
  const { data, info } = await sharp(bytes).raw().toBuffer({ resolveWithObject: true });
  if (
    info.width !== width ||
    info.height !== height ||
    info.channels !== 3 ||
    data.length !== source.length
  )
    throw new Error('decoded shape mismatch');
  let squared = 0;
  for (let i = 0; i < source.length; i++) squared += (data[i] - source[i]) ** 2;
  return {
    bytes: bytes.length,
    psnr: 10 * Math.log10(255 ** 2 / (squared / source.length)),
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
}
const sharpRows = [];
for (let quality = 1; quality <= 100; quality++)
  sharpRows.push({
    quality,
    ...(await inspect(
      await sharp(Buffer.from(source), { raw: { width, height, channels: 3 } })
        .avif({ quality, bitdepth: 8, effort: 4, chromaSubsampling: '4:4:4' })
        .toBuffer(),
    )),
  });
const rows = [];
for (const quality of [30, 50, 60, 80, 95]) {
  const mine = await inspect(
    await maple({ data: source, width, height, channels: 3 })
      .avif({ quality, bitdepth: 8, effort: 4, chromaSubsampling: '4:4:4' })
      .toBuffer(),
  );
  const theirs = sharpRows[quality - 1];
  const nearest = sharpRows.reduce((best, row) =>
    Math.abs(row.bytes - mine.bytes) < Math.abs(best.bytes - mine.bytes) ? row : best,
  );
  rows.push({ quality, maple: mine, sharp: theirs, nearestSharpRate: nearest });
}
console.log(
  JSON.stringify(
    {
      versions: sharp.versions,
      nativeLibrary: {
        path: nativeLibrary,
        sha256: createHash('sha256').update(readFileSync(nativeLibrary)).digest('hex'),
      },
      bun: Bun.version,
      platform: process.platform,
      arch: process.arch,
      width,
      height,
      sourceSha256: createHash('sha256').update(source).digest('hex'),
      options: { bitdepth: 8, effort: 4, chromaSubsampling: '4:4:4' },
      rows,
      sharpSweep: sharpRows,
    },
    null,
    2,
  ),
);
