import { readFile, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { walkFiles } from './lib/walk-files.mjs';

const artifactRoot = resolve(
  process.env.MAPLE_HOSTED_ARTIFACT ??
    fileURLToPath(new URL('../dist/maple-syrup/browser', import.meta.url)),
);
// #2709: this used to stat only main-*.js. That was a sound proxy while
// Hosted's initial payload was essentially one eager bundle, but esbuild
// factors shared framework code into its own eager chunk as soon as any
// code-splitting happens (first hit in #2643/#2705's @defer split) — main
// shrinks, the ratchet reports a large win, and the actual initial payload
// can be flat or worse. `index.html`'s `<script src>` (the entry) plus its
// `<link rel="modulepreload">` hrefs are exactly the chunks the browser
// fetches before the app can render a frame — Angular's esbuild builder
// emits a modulepreload for every eagerly (statically) imported chunk and
// none for a lazy-route or `@defer` chunk, which is only ever reached via a
// runtime `import()` the builder can't know is coming. Summing those is the
// actual initial payload; anything else in dist/ is deferred by definition.
const MAX_EAGER_BYTES = 1_160_000;
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
  // NOTE: the bare 'Timeline' marker was retired when the Maple UI design
  // system (#3000) added a legitimate hosted Timeline organism
  // (mui-timeline / mui-page-tv-timeline) — the specific markers
  // 'Timeline view' + 'app-timeline-view' still guard the Self Hosted
  // timeline surface leaking into the hosted bundle.
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
    // Folder CRUD (#2643 / #2705 review): the eager tree component may only
    // reference `FolderTreeCrudComponent` (and only inside an `@defer`
    // block, in the .html above) — never the HTTP service or the
    // menu/dialog components directly. Those live exclusively behind that
    // `@defer` boundary so they code-split into their own chunk.
    path: new URL(
      '../projects/maple-common/src/lib/components/folder-tree/folder-tree.component.ts',
      import.meta.url,
    ),
    forbidden: [
      'FolderCrudService',
      'FolderContextMenuComponent',
      'FolderNewFolderDialogComponent',
      'FolderRenameDialogComponent',
      'FolderTrashConfirmDialogComponent',
    ],
  },
  {
    path: new URL('../projects/maple-syrup/src/app/app.config.ts', import.meta.url),
    forbidden: [
      'InfoEnrichmentComponent',
      'SelfHostedSidebarHeaderComponent',
      'SelfHostedSidebarBodyComponent',
      'FolderTreeCrudComponent',
      'provideFolderTreeCrud',
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
    'provideFolderTreeCrud()',
  ],
};

const scripts = await walkFiles(artifactRoot, (path) => path.endsWith('.js'));

/** Strip a query/hash suffix and a leading `./` or `/` from a parsed href
 * so it matches a plain filename under `artifactRoot` regardless of how the
 * builder wrote it — root-relative (`/main-...js`) and dot-relative
 * (`./main-...js`) hrefs are both plausible depending on `baseHref`/deploy-
 * url config, not just the bare filename this build happens to emit today
 * (Copilot review, PR #3141). */
function normalizeHref(href) {
  return href.split(/[?#]/)[0].replace(/^\.?\//, '');
}

/** Every href this build's `index.html` marks as eagerly needed: the entry
 * `<script src>` plus every `<link rel="modulepreload">` — the set the
 * browser fetches before the app can render a first frame. A chunk reached
 * only via a runtime `import()` (a lazy route, an `@defer` block) gets
 * neither, so it's excluded by construction rather than by a marker list
 * this script would have to keep in sync with the app's route/defer graph. */
function eagerHrefsFromIndexHtml(html) {
  const scriptSrcs = [...html.matchAll(/<script\b[^>]*\bsrc="([^"]+)"[^>]*>/g)].map((m) => m[1]);
  const modulepreloadHrefs = (html.match(/<link\b[^>]*>/g) ?? [])
    .filter((tag) => /\brel="modulepreload"/.test(tag))
    .map((tag) => tag.match(/\bhref="([^"]+)"/)?.[1])
    .filter((href) => href !== undefined);
  const normalized = [...scriptSrcs, ...modulepreloadHrefs].map(normalizeHref);
  return [...new Set(normalized)];
}

/** Resolve an eager href to a file under `artifactRoot`, refusing to follow
 * it outside that directory — an unexpected `../` traversal or an
 * absolute/external href in a hand-authored `index.html` should fail loudly
 * rather than `stat()` an arbitrary path (Copilot review, PR #3141). */
function resolveEagerFile(href) {
  const resolved = resolve(artifactRoot, href);
  const rel = relative(artifactRoot, resolved);
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`Eager href "${href}" resolves outside ${artifactRoot}: ${resolved}`);
  }
  return resolved;
}

const indexHtmlPath = resolve(artifactRoot, 'index.html');
const indexHtml = await readFile(indexHtmlPath, 'utf8');
const eagerHrefs = eagerHrefsFromIndexHtml(indexHtml);
const entryHrefs = eagerHrefs.filter((href) => /^main-[A-Za-z0-9]+\.js$/.test(href));
if (entryHrefs.length !== 1) {
  throw new Error(`Expected one Hosted main bundle in ${indexHtmlPath}, found ${entryHrefs.length}`);
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

const eagerSizes = await Promise.all(
  eagerHrefs.map(async (href) => {
    const size = (await stat(resolveEagerFile(href))).size;
    return { href, size };
  }),
);
const eagerBytes = eagerSizes.reduce((total, { size }) => total + size, 0);
if (eagerBytes > MAX_EAGER_BYTES) {
  const breakdown = eagerSizes
    .sort((a, b) => b.size - a.size)
    .map(({ href, size }) => `  ${href}: ${size}`)
    .join('\n');
  throw new Error(
    `Hosted eager payload is ${eagerBytes} bytes; ratchet is ${MAX_EAGER_BYTES}\n${breakdown}`,
  );
}

console.log(
  `Hosted capability boundary passed (${eagerBytes}/${MAX_EAGER_BYTES} eager bytes across ${eagerHrefs.length} chunk(s)).`,
);
