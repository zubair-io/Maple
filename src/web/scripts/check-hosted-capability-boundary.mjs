import { readdir, readFile, stat } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const artifactRoot = resolve(
  process.env.MAPLE_HOSTED_ARTIFACT ??
    fileURLToPath(new URL('../dist/maple-syrup/browser', import.meta.url)),
);
const MAX_MAIN_BYTES = 880_000;
const SERVER_ONLY_MARKERS = [
  '/api/metadata/snapshots',
  '/api/pano/stitch',
  '/api/xmp/batch',
  'Merge to panorama',
  'Timeline view',
  'app-batch-metadata-panel',
  'app-pano-dialog',
  'app-timeline-view',
];

async function javascriptFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) return javascriptFiles(path);
      return path.endsWith('.js') ? [path] : [];
    }),
  );
  return files.flat();
}

const scripts = await javascriptFiles(artifactRoot);
const mainScripts = scripts.filter((path) => /^main-[A-Z0-9]+\.js$/.test(basename(path)));
if (mainScripts.length !== 1) {
  throw new Error(`Expected one Hosted main bundle, found ${mainScripts.length}`);
}

for (const path of scripts) {
  const source = await readFile(path, 'utf8');
  const marker = SERVER_ONLY_MARKERS.find((candidate) => source.includes(candidate));
  if (marker) throw new Error(`Hosted bundle ${path} contains server-only marker: ${marker}`);
}

const mainBytes = (await stat(mainScripts[0])).size;
if (mainBytes > MAX_MAIN_BYTES) {
  throw new Error(`Hosted main bundle is ${mainBytes} bytes; ratchet is ${MAX_MAIN_BYTES}`);
}

console.log(`Hosted capability boundary passed (${mainBytes}/${MAX_MAIN_BYTES} main bytes).`);
