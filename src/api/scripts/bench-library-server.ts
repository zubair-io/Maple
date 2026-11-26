// fallow-ignore-file complexity code-duplication
/**
 * Shared fixture for the server benchmarks: builds a throwaway library (generated photos,
 * realistic ~20 KB sidecars, optional thumbs, optional indexed catalog) plus a SQLite file,
 * and boots the real server (`src/index.ts`) against them.
 *
 * `--api-root` points at another checkout's `src/api` (with `node_modules` and `native` present)
 * so a baseline tree and HEAD run the identical harness.
 */
import { Database } from 'bun:sqlite';
import { mkdir, mkdtemp, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const argv = Bun.argv.slice(2);
export const flag = (name: string, fallback: string): string => {
  const at = argv.indexOf(`--${name}`);
  return at >= 0 && argv[at + 1] !== undefined ? argv[at + 1]! : fallback;
};
export const apiRoot = resolve(flag('api-root', join(import.meta.dir, '..')));
export const photoCount = Number(flag('photos', '2000'));
export const sidecarCount = Number(flag('sidecars', '1000'));
export const indexed = flag('indexed', 'yes') === 'yes';
export const withThumbs = flag('thumbs', 'yes') === 'yes';
export const thumbBytes = Number(flag('thumb-bytes', '18000'));
export const runs = Number(flag('runs', '15'));
export const jsonOutput = argv.includes('--json');
const edgeCases = argv.includes('--edge');
export const dumpFile = flag('dump', '');
const profileDir = flag('profile-dir', '');
const PORT = 3400 + Math.floor(Math.random() * 400);
export const SLUG = 'benchlib';
export const FOLDER_ID = '65a000000000000000000001';
const EXTENSIONS = ['jpg', 'jpg', 'dng', 'heic', 'jpg', 'cr3'];

function sidecarXml(seed: number, targetBytes: number): string {
  const dab = (i: number) =>
    `          <rdf:li>d ${(0.2 + ((i * 7 + seed) % 600) / 1000).toFixed(6)} ${(0.3 + ((i * 13 + seed) % 500) / 1000).toFixed(6)}</rdf:li>\n`;
  const head = `<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description rdf:about=""
    xmlns:xmp="http://ns.adobe.com/xap/1.0/"
    xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/"
    xmlns:papp="http://ns.justmaple.app/photo/1.0/"
   xmp:Rating="${seed % 6}"
   xmp:Label="${['Red', 'Yellow', 'Green', 'Blue', 'Purple'][seed % 5]}"
   crs:Version="15.4"
   crs:ProcessVersion="11.0"
   crs:Exposure2012="+0.35"
   crs:Contrast2012="12"
   crs:Highlights2012="-20"
   papp:Profile="Auto">
   <crs:PaintBasedCorrections>
    <rdf:Seq>
     <rdf:li>
      <rdf:Description crs:What="Correction" crs:CorrectionAmount="1.000000" crs:LocalExposure2012="0.650000">
       <crs:CorrectionMasks>
        <rdf:Seq>
         <rdf:li crs:What="Mask/Paint" crs:MaskValue="1.000000" crs:Radius="0.084351">
          <crs:Dabs>
           <rdf:Seq>
`;
  const tail = `           </rdf:Seq>
          </crs:Dabs>
         </rdf:li>
        </rdf:Seq>
       </crs:CorrectionMasks>
      </rdf:Description>
     </rdf:li>
    </rdf:Seq>
   </crs:PaintBasedCorrections>
  </rdf:Description>
 </rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>
`;
  const dabCount = Math.max(1, Math.round((targetBytes - head.length - tail.length) / 62));
  return head + Array.from({ length: dabCount }, (_, i) => dab(i)).join('') + tail;
}

interface Workspace {
  root: string;
  library: string;
  sqlitePath: string;
}

const EDGE_PHOTOS = [
  'real-target.jpg',
  'link-inside.jpg',
  'link-escape.jpg',
  'link-dangling.jpg',
  'link-sidecar-photo.jpg',
  'escape-sidecar-photo.jpg',
  'dir-sidecar-photo.jpg',
];

async function addEdgeCases(root: string, library: string, baseTime: number): Promise<void> {
  await mkdir(join(root, 'outside'), { recursive: true });
  await writeFile(join(root, 'outside', 'secret.jpg'), 'outside');
  await writeFile(join(root, 'outside', 'secret.xmp'), sidecarXml(7, 3000));
  await mkdir(join(library, 'sub', 'deeper'), { recursive: true });
  await mkdir(join(library, 'ignored'), { recursive: true });
  await writeFile(join(library, 'ignored', '.mapleignore'), '');
  await writeFile(join(library, 'real-target.jpg'), 'target');
  await writeFile(join(library, 'real-target.xmp'), sidecarXml(3, 5000));
  await writeFile(join(library, 'sub', 'inner.jpg'), 'inner');
  await symlink(join(library, 'real-target.jpg'), join(library, 'link-inside.jpg'));
  await symlink(join(root, 'outside', 'secret.jpg'), join(library, 'link-escape.jpg'));
  await symlink(join(library, 'does-not-exist.jpg'), join(library, 'link-dangling.jpg'));
  await symlink(join(root, 'outside', 'secret.xmp'), join(library, 'IMG_00000.xmp.bak'));
  await symlink(join(library, 'real-target.xmp'), join(library, 'link-sidecar-photo.xmp'));
  await writeFile(join(library, 'link-sidecar-photo.jpg'), 'photo');
  await symlink(join(root, 'outside', 'secret.xmp'), join(library, 'escape-sidecar-photo.xmp'));
  await writeFile(join(library, 'escape-sidecar-photo.jpg'), 'photo');
  await mkdir(join(library, 'dir-sidecar-photo.xmp'));
  await writeFile(join(library, 'dir-sidecar-photo.jpg'), 'photo');
  await symlink(join(library, 'sub'), join(library, 'link-folder'));
  await symlink(join(root, 'outside'), join(library, 'link-folder-escape'));
  await writeFile(join(library, '.hidden.jpg'), 'hidden');
  await writeFile(join(library, 'notes.txt'), 'notes');
  await Promise.all(
    [
      ...EDGE_PHOTOS.filter((name) => name !== 'link-dangling.jpg'),
      'dir-sidecar-photo.xmp',
      'sub',
      'real-target.xmp',
      'notes.txt',
    ].map((name) => utimes(join(library, name), baseTime, baseTime)),
  );
}

export async function buildWorkspace(): Promise<Workspace> {
  const root = await mkdtemp(join(tmpdir(), 'maple-bench-listing-'));
  const library = join(root, 'library');
  await mkdir(join(library, '.maple', 'thumbs'), { recursive: true });
  const { resolveThumbPath } = await import(join(apiRoot, 'src/fs/xmp.ts'));
  const baseTime = 1_700_000_000;
  const generated = Array.from(
    { length: photoCount },
    (_, i) => `IMG_${String(i).padStart(5, '0')}.${EXTENSIONS[i % EXTENSIONS.length]}`,
  );
  const names = edgeCases ? [...generated, ...EDGE_PHOTOS] : generated;
  await Promise.all(
    generated.map(async (name, i) => {
      const file = join(library, name);
      await writeFile(file, `fake-image-${i}`.padEnd(4096, 'x'));
      await utimes(file, baseTime, baseTime);
      if (i % Math.max(1, Math.round(photoCount / Math.max(sidecarCount, 1))) === 0) {
        const sidecar = join(library, `${name.replace(/\.[^.]+$/, '')}.xmp`);
        await writeFile(sidecar, sidecarXml(i, 20_000));
        await utimes(sidecar, baseTime + 10, baseTime + 10);
      }
    }),
  );
  if (edgeCases) await addEdgeCases(root, library, baseTime);
  if (withThumbs) {
    await Promise.all(
      names.map(async (name) => {
        const thumb = resolveThumbPath(join(library, name));
        await writeFile(thumb, 'avif'.padEnd(thumbBytes, 'a'));
        await utimes(thumb, baseTime + 60, baseTime + 60);
      }),
    );
  }
  const sqlitePath = join(root, 'maple.sqlite');
  const db = new Database(sqlitePath);
  const { SCHEMA_PRAGMAS } = await import(join(apiRoot, 'src/db/sqlite/ddl/index.ts'));
  const { fromBunSqlite, runMigrations } = await import(join(apiRoot, 'src/db/sqlite/migrate.ts'));
  const { ALL_MIGRATIONS } = await import(join(apiRoot, 'src/db/sqlite/migrations/index.ts'));
  for (const pragma of SCHEMA_PRAGMAS) db.exec(pragma);
  await runMigrations(fromBunSqlite(db), ALL_MIGRATIONS);
  const folderId = FOLDER_ID;
  db.run(
    `INSERT INTO folders (id, path, slug, label, file_count, created_at) VALUES (?, ?, ?, ?, 0, ?)`,
    [folderId, library, SLUG, 'Bench', new Date().toISOString()],
  );
  if (indexed) {
    const insertAsset = db.prepare(
      `INSERT INTO assets (id, maple_id, size, mtime, indexed_at, exif, media_kind)
       VALUES (?, ?, ?, ?, ?, ?, 'image')`,
    );
    const insertLocation = db.prepare(
      `INSERT INTO asset_locations (asset_id, ordinal, library_id, path, filename) VALUES (?, 0, ?, '', ?)`,
    );
    db.transaction(() => {
      names.forEach((name, i) => {
        const id = `65b${String(i).padStart(21, '0')}`;
        const capturedAt = new Date(1_700_000_000_000 + i * 60_000).toISOString();
        insertAsset.run(
          id,
          `${i.toString(16).padStart(16, '0')}`,
          4096,
          Math.round(baseTime * 1000),
          new Date().toISOString(),
          JSON.stringify({
            width: 6000,
            height: 4000,
            captured_at: capturedAt,
            make: 'SONY',
            model: 'ILCE-7M4',
            iso: 100 + (i % 6400),
            aperture: 2.8,
            shutter: '1/250',
            focal_length: 35,
          }),
        );
        insertLocation.run(id, folderId, name);
      });
    })();
  }
  db.close();
  return { root, library, sqlitePath };
}

export async function bootServer(work: Workspace) {
  const child = Bun.spawn(
    [
      'bun',
      ...(profileDir ? ['--cpu-prof', '--cpu-prof-md', `--cpu-prof-dir=${profileDir}`] : []),
      join(apiRoot, 'src/index.ts'),
    ],
    {
      cwd: work.root,
      env: {
        ...process.env,
        PORT: String(PORT),
        MAPLE_SQLITE_PATH: work.sqlitePath,
        MAPLE_NATIVE_LIB: join(apiRoot, 'native', 'libraw_ffi.dylib'),
        MAPLE_DEV_AUTH: '1',
        MAPLE_INDEXER_AUTOSTART: '0',
        MAPLE_JWT_SECRET: 'bench-secret-bench-secret-1234',
        MAPLE_BACKUP_TMP: join(work.root, 'chunks'),
        LOG_LEVEL: 'warn',
      },
      stdout: 'ignore',
      stderr: argv.includes('--server-stderr') ? 'inherit' : 'ignore',
    },
  );
  const base = `http://127.0.0.1:${PORT}`;
  for (let attempt = 0; attempt < 200; attempt++) {
    const ready = await fetch(`${base}/api/health`)
      .then((r) => r.ok)
      .catch(() => false);
    if (ready) break;
    await Bun.sleep(50);
  }
  const login = (await fetch(`${base}/api/auth/dev-login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  }).then((r) => r.json())) as { access_token: string };
  return { child, base, token: login.access_token };
}

export interface Sample {
  wallMs: number;
  serverMs: number | null;
  status: number;
  bytes: number;
  etag: string | null;
}

export async function timed(url: string, headers: Record<string, string>): Promise<Sample> {
  const started = performance.now();
  const response = await fetch(url, { headers });
  const body = await response.arrayBuffer();
  const wallMs = performance.now() - started;
  const timing = response.headers.get('server-timing')?.match(/dur=([\d.]+)/);
  const declared = Number(response.headers.get('content-length') ?? NaN);
  return {
    wallMs,
    serverMs: timing ? Number(timing[1]) : null,
    status: response.status,
    bytes: Number.isFinite(declared) && declared > 0 ? declared : body.byteLength,
    etag: response.headers.get('etag'),
  };
}

export const median = (values: number[]) =>
  [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]!;
export const summarize = (samples: Sample[]) => ({
  wallMin: Math.min(...samples.map((s) => s.wallMs)),
  wallMedian: median(samples.map((s) => s.wallMs)),
  serverMedian: samples[0]?.serverMs == null ? null : median(samples.map((s) => s.serverMs!)),
  status: samples[0]!.status,
  bytes: samples[0]!.bytes,
});

/** CPU seconds the process has used (user + system), from `ps`; its resolution is 10 ms. */
export async function processCpuSeconds(pid: number): Promise<number> {
  const out = (await Bun.$`ps -o time= -p ${pid}`.text()).trim();
  const [minutes, seconds] = out.split(':');
  return Number(minutes) * 60 + Number(seconds);
}
