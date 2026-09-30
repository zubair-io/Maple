/** Regenerate tiny, synthetic metadata fixtures and their Sharp oracle (#3590).
 * Run with Bun after building raw-ffi/raw-napi and src/maple/dist.
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { maple } from '../src/maple/src/index';

const root = path.resolve(import.meta.dir, '..');
const sharp = require(require.resolve('sharp', { paths: [path.join(root, 'src/api')] }));
const output = path.join(root, 'test-fixtures/raster-metadata');
const fields = [
  'width',
  'height',
  'space',
  'depth',
  'channels',
  'hasAlpha',
  'isProgressive',
  'isPalette',
  'bitsPerSample',
  'paletteBitDepth',
  'chromaSubsampling',
  'pages',
  'pagePrimary',
  'compression',
  'resolutionUnit',
  'autoOrient',
  'xmpAsString',
];
const source = (pages = 1, channels = 3) => ({
  data: Buffer.from(
    Array.from(
      { length: 24 * 16 * channels * pages },
      (_, i) => (i * 7 + Math.floor(i / 1152) * 37) % 251,
    ),
  ),
  width: 24,
  height: 16 * pages,
  channels,
  pageHeight: 16,
});
const rgb = source();
const grayAlpha = source(1, 2);
const cases: [string, Promise<Buffer>][] = [
  [
    'progressive-444.jpg',
    sharp(rgb.data, { raw: rgb })
      .jpeg({ progressive: true, chromaSubsampling: '4:4:4' })
      .toBuffer(),
  ],
  [
    'palette-4-interlaced.png',
    sharp(rgb.data, { raw: rgb }).png({ palette: true, colours: 16, progressive: true }).toBuffer(),
  ],
  [
    'gray-alpha-16.png',
    sharp(grayAlpha.data, { raw: grayAlpha }).toColourspace('grey16').png().toBuffer(),
  ],
  [
    'gray-alpha-16.tiff',
    sharp(grayAlpha.data, { raw: grayAlpha })
      .toColourspace('grey16')
      .tiff({ compression: 'none' })
      .toBuffer(),
  ],
  ['rgb-16.png', sharp(rgb.data, { raw: rgb }).toColourspace('rgb16').png().toBuffer()],
  [
    'avif-10.avif',
    maple({ ...rgb, channels: 3 })
      .avif({ bitdepth: 10 })
      .toBuffer(),
  ],
];
for (const format of ['tiff', 'gif', 'webp']) {
  const raw = source(3);
  cases.push([`three-pages.${format}`, sharp(raw.data, { raw }).toFormat(format).toBuffer()]);
}
// Exercise a nonzero primary page and a hidden image using the real AV1
// payload. Both image items legally reference the same encoded extent.
const splitBoxes = (bytes: Buffer): [string, Buffer][] => {
  const boxes: [string, Buffer][] = [];
  for (let at = 0; at < bytes.length; ) {
    const size = bytes.readUInt32BE(at);
    boxes.push([bytes.toString('ascii', at + 4, at + 8), bytes.subarray(at + 8, at + size)]);
    at += size;
  }
  return boxes;
};
const box = (kind: string, payload: Buffer) => {
  const header = Buffer.alloc(8);
  header.writeUInt32BE(8 + payload.length);
  header.write(kind, 4);
  return Buffer.concat([header, payload]);
};
function twoPagesAvif(bytes: Buffer, hiddenFirst: boolean): Buffer {
  const top = new Map(splitBoxes(bytes));
  const meta = new Map(splitBoxes(top.get('meta')!.subarray(4)));
  const primary = Buffer.from(meta.get('pitm')!);
  primary.writeUInt16BE(2, 4);
  const originalInfo = splitBoxes(meta.get('iinf')!.subarray(6))[0][1];
  const firstInfo = Buffer.from(originalInfo);
  firstInfo[3] = hiddenFirst ? 1 : 0;
  const secondInfo = Buffer.from(originalInfo);
  secondInfo.writeUInt16BE(2, 4);
  const infoHeader = Buffer.alloc(6);
  infoHeader.writeUInt16BE(2, 4);
  const iinf = Buffer.concat([infoHeader, box('infe', firstInfo), box('infe', secondInfo)]);
  const iprp = new Map(splitBoxes(meta.get('iprp')!));
  const associations = Buffer.from(iprp.get('ipma')!);
  associations.writeUInt32BE(2, 4);
  const secondAssociations = Buffer.from(associations.subarray(8));
  secondAssociations.writeUInt16BE(2);
  const properties = Buffer.concat([
    box('ipco', iprp.get('ipco')!),
    box('ipma', Buffer.concat([associations, secondAssociations])),
  ]);
  const location = Buffer.from(meta.get('iloc')!);
  // These synthetic inputs are the Maple muxer's v0, 32-bit extent layout.
  if (location[0] !== 0 || location[4] !== 0x44 || location[5] !== 0)
    throw new Error('Unexpected fixture iloc');
  location.writeUInt16BE(2, 6);
  const secondLocation = Buffer.from(location.subarray(8));
  secondLocation.writeUInt16BE(2);
  const iloc = Buffer.concat([location, secondLocation]);
  const buildMeta = () =>
    box(
      'meta',
      Buffer.concat([
        Buffer.alloc(4),
        box('hdlr', meta.get('hdlr')!),
        box('pitm', primary),
        box('iloc', iloc),
        box('iinf', iinf),
        box('iprp', properties),
      ]),
    );
  const ftyp = box('ftyp', top.get('ftyp')!);
  const offset = ftyp.length + buildMeta().length + 8;
  iloc.writeUInt32BE(offset, 14);
  iloc.writeUInt32BE(offset, 28);
  return Buffer.concat([ftyp, buildMeta(), box('mdat', top.get('mdat')!)]);
}
const avif = await cases.find(([name]) => name === 'avif-10.avif')![1];
cases.push(['avif-two-pages.avif', Promise.resolve(twoPagesAvif(avif, false))]);
cases.push(['avif-hidden-page.avif', Promise.resolve(twoPagesAvif(avif, true))]);
await fs.mkdir(output, { recursive: true });
const manifest: Record<string, unknown> = {};
for (const [name, pending] of cases) {
  const bytes = await pending;
  const expected = await sharp(bytes).metadata();
  manifest[name] = Object.fromEntries(fields.map((field) => [field, expected[field] ?? null]));
  await fs.writeFile(path.join(output, name), bytes);
}
await fs.writeFile(path.join(output, 'expected.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(`Wrote ${cases.length} synthetic metadata fixtures with Sharp ${sharp.versions.sharp}`);
