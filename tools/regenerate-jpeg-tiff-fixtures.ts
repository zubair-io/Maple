/** #3591: real Sharp/libtiff compressed TIFFs and libjpeg-decoded RGB oracles. */
import { mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';

const require = createRequire(new URL('../src/api/package.json', import.meta.url));
const sharp = require('sharp') as typeof import('../src/api/node_modules/sharp');
const directory = fileURLToPath(new URL('../test-fixtures/jpeg-tiff/', import.meta.url));
await mkdir(directory, { recursive: true });
const cases = [
  { name: 'strips', width: 73, height: 273, options: {} },
  { name: 'tiles', width: 67, height: 45, options: { tile: true, tileWidth: 32, tileHeight: 32 } },
  {
    name: 'bigtiff',
    width: 67,
    height: 45,
    options: { bigtiff: true, tile: true, tileWidth: 32, tileHeight: 32 },
  },
  { name: 'quality40', width: 31, height: 27, options: { quality: 40 } },
  { name: 'quality95', width: 31, height: 27, options: { quality: 95 } },
  { name: 'orientation6', width: 31, height: 27, options: {}, orientation: 6 },
];
for (const entry of cases) {
  const { width, height } = entry;
  const pixels = Buffer.from(
    Array.from({ length: width * height }, (_, i) => {
      const x = i % width;
      const y = Math.floor(i / width);
      return [(x * 5 + y * 3) % 256, (x * 2 + y * 7) % 256, (x * 3 + y * 2) % 256];
    }).flat(),
  );
  const input = sharp(pixels, { raw: { width, height, channels: 3 } });
  const configured = entry.orientation
    ? input.withMetadata({ orientation: entry.orientation })
    : input;
  const tiff = await configured.tiff(entry.options).toBuffer();
  const expected = await sharp(tiff).removeAlpha().raw().toBuffer();
  await writeFile(path.join(directory, `${entry.name}.tiff`), tiff);
  await writeFile(path.join(directory, `${entry.name}.rgb`), expected);
  if (entry.orientation) {
    const rotated = await sharp(tiff).rotate().removeAlpha().raw().toBuffer();
    await writeFile(path.join(directory, `${entry.name}.rotated.rgb`), rotated);
  }
}
console.log(
  `Wrote ${cases.length} JPEG TIFF fixtures using Sharp ${sharp.versions.sharp}, libvips ${sharp.versions.vips}`,
);
