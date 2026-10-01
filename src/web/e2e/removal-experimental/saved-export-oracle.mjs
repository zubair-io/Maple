// Actual cold WASM export oracle, executed in native Node ESM by Playwright.
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import {
  initSync,
  NativeDetailSession,
} from '../../projects/maple-common/src/lib/raw-pipeline/pkg/raw_wasm.js';
const [root, output] = process.argv.slice(2);
if (!root || !output) throw new Error('Usage: saved-export-oracle.mjs ROOT OUTPUT');
initSync({
  module: await readFile(
    resolve(
      import.meta.dirname,
      '../../projects/maple-common/src/lib/raw-pipeline/pkg/raw_wasm_bg.wasm',
    ),
  ),
});
const raw = new Uint8Array(await readFile(join(root, 'photo.dng')));
const xmp = await readFile(join(root, 'photo.xmp'), 'utf8');
const names = (await readdir(join(root, '.maple/inpaint'))).sort();
const files = await Promise.all(names.map((name) => readFile(join(root, '.maple/inpaint', name))));
const companions = Buffer.concat(files);
const manifest = JSON.stringify(
  names.map((name, index) => ({ name, length: files[index].length })),
);
const session = new NativeDetailSession(raw, 'dng');
try {
  session.prepare_saved_removals(xmp, manifest, companions);
  const encoded = session.export_saved_removals(
    xmp,
    JSON.stringify({ format: 'png', quality: 92, color_space: 'srgb', max_long_edge: 0 }),
    new Uint8Array(),
  );
  try {
    await writeFile(output, encoded.chunk(0, encoded.byteLength));
  } finally {
    encoded.free();
  }
} finally {
  session.free();
}
