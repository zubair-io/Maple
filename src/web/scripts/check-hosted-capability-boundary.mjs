import { readdir, readFile, stat } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const artifactRoot = resolve(
  process.env.MAPLE_HOSTED_ARTIFACT ??
    fileURLToPath(new URL('../dist/maple-syrup/browser', import.meta.url)),
);
const MAX_MAIN_BYTES = 840_000;
const SERVER_ONLY_MARKERS = [
  '/api/metadata/snapshots',
  '/api/pano/stitch',
  '/api/fs/list',
  '/api/xmp/batch',
  '/assets/by-address',
  '/enrichment/requeue',
  '/workers/status',
  '/display/config',
  '/photos/hidden',
  '/settings/workers',
  'Merge to panorama',
  'Timeline view',
  'Add folder',
  'Timeline',
  'app-batch-metadata-panel',
  'app-pano-dialog',
  'app-timeline-view',
];

const SOURCE_BOUNDARIES = [
  {
    path: new URL('../projects/maple-common/src/lib/info/info-panel.component.ts', import.meta.url),
    forbidden: ['InfoEnrichmentComponent', 'BunApiBackendService', 'LIBRARY_BACKEND'],
  },
  {
    path: new URL(
      '../projects/maple-common/src/lib/components/folder-tree/folder-tree.component.html',
      import.meta.url,
    ),
    forbidden: ['Add folder', 'Timeline'],
  },
  {
    path: new URL('../projects/maple-syrup/src/app/app.config.ts', import.meta.url),
    forbidden: [
      'InfoEnrichmentComponent',
      'SelfHostedSidebarHeaderComponent',
      'SelfHostedSidebarBodyComponent',
    ],
  },
];

const SELF_HOSTED_COMPOSITION = {
  path: new URL('../projects/maple/src/app/app.config.ts', import.meta.url),
  required: [
    'provideInfoPanelExtension(InfoEnrichmentComponent)',
    'provideFolderTreeExtensions({',
    'header: SelfHostedSidebarHeaderComponent',
    'body: SelfHostedSidebarBodyComponent',
  ],
};

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

for (const boundary of SOURCE_BOUNDARIES) {
  const source = await readFile(boundary.path, 'utf8');
  const marker = boundary.forbidden.find((candidate) => source.includes(candidate));
  if (marker) {
    throw new Error(
      `Guarded source ${boundary.path.pathname} contains forbidden Hosted capability: ${marker}`,
    );
  }
}

const selfHostedSource = await readFile(SELF_HOSTED_COMPOSITION.path, 'utf8');
for (const marker of SELF_HOSTED_COMPOSITION.required) {
  if (!selfHostedSource.includes(marker)) {
    throw new Error(`Self Hosted composition is missing capability provider: ${marker}`);
  }
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
