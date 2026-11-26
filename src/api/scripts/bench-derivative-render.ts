// fallow-ignore-file complexity code-duplication
/**
 * Derivative render benchmark with real RAW fixtures: boots the real server against copies
 * (APFS clones) of RAWs from `test-fixtures/raws`, half of them carrying an authored sidecar,
 * and times the first (render) and second (cached) `GET /api/thumb` and `GET /api/preview`.
 *
 *   bun scripts/bench-derivative-render.ts --photos 0 --thumbs no --indexed no [--api-root DIR]
 *     [--fixtures DIR] [--files 8] [--burst] [--server-stderr]
 *
 * Needs the native dylib (`scripts/build-raw-ffi.sh`) and the gitignored RAW fixtures.
 */
import { Database } from 'bun:sqlite';
import { readdirSync } from 'node:fs';
import { constants, copyFile, mkdir, rm, writeFile } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import {
  FOLDER_ID,
  apiRoot,
  bootServer,
  buildWorkspace,
  flag,
  jsonOutput,
  median,
  SLUG,
} from './bench-library-server.ts';

const RAW_EXT = new Set(['.dng', '.cr2', '.cr3', '.nef', '.arw', '.raf', '.fff', '.raw', '.x3f']);
const fixtureDir = flag('fixtures', join(import.meta.dir, '../../../test-fixtures/raws'));
const fileCount = Number(flag('files', '8'));
const EDITED_SIDECAR = `<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
<rdf:Description rdf:about="" xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/" xmlns:papp="http://ns.justmaple.app/photo/1.0/"
 crs:Version="15.4" crs:ProcessVersion="11.0" crs:HasSettings="True" crs:Exposure2012="+0.50" crs:Contrast2012="+10" papp:Profile="Auto"/>
</rdf:RDF></x:xmpmeta>
<?xpacket end="w"?>
`;

interface Pick {
  name: string;
  edited: boolean;
}

function pickFixtures(): string[] {
  return readdirSync(fixtureDir)
    .filter((name) => RAW_EXT.has(extname(name).toLowerCase()) && !name.startsWith('test_0000'))
    .filter((name) => !name.includes('100mp') && !name.startsWith('pano'))
    .sort()
    .slice(0, fileCount);
}

async function timedGet(
  base: string,
  headers: Record<string, string>,
  path: string,
): Promise<{ ms: number; status: number; bytes: number }> {
  const started = performance.now();
  const response = await fetch(`${base}${path}`, { headers });
  const body = await response.arrayBuffer();
  return { ms: performance.now() - started, status: response.status, bytes: body.byteLength };
}

async function main() {
  const work = await buildWorkspace();
  const names = pickFixtures();
  const picks: Pick[] = names.map((name, i) => ({ name, edited: i % 2 === 1 }));
  await mkdir(work.library, { recursive: true });
  for (const pick of picks) {
    await copyFile(
      join(fixtureDir, pick.name),
      join(work.library, pick.name),
      constants.COPYFILE_FICLONE,
    );
    if (pick.edited) {
      const stem = basename(pick.name, extname(pick.name));
      await writeFile(join(work.library, `${stem}.xmp`), EDITED_SIDECAR);
    }
  }
  const db = new Database(work.sqlitePath);
  picks.forEach((pick, i) => {
    const id = `65c${String(i).padStart(21, '0')}`;
    db.run(
      `INSERT INTO assets (id, maple_id, size, mtime, indexed_at, exif, media_kind)
       VALUES (?, ?, 1, ?, ?, '{}', 'image')`,
      [id, `${(i + 1).toString(16).padStart(16, '0')}`, Date.now(), new Date().toISOString()],
    );
    db.run(
      `INSERT INTO asset_locations (asset_id, ordinal, library_id, path, filename) VALUES (?, 0, ?, '', ?)`,
      [id, FOLDER_ID, pick.name],
    );
  });
  db.close();
  const server = await bootServer(work);
  try {
    const auth = { Authorization: `Bearer ${server.token}` };
    if (process.argv.includes('--burst')) {
      const started = performance.now();
      const burst = await Promise.all(
        picks.map((pick) => timedGet(server.base, auth, `/api/thumb/${SLUG}/${pick.name}`)),
      );
      const summary = {
        apiRoot,
        ffiWorkers: process.env.MAPLE_FFI_WORKERS ?? 'default',
        files: picks.length,
        burstTotalMs: Math.round(performance.now() - started),
        statuses: burst.map((result) => result.status),
      };
      console.log(JSON.stringify(summary));
      return;
    }
    const rows: Record<string, unknown>[] = [];
    for (const pick of picks) {
      const thumb = `/api/thumb/${SLUG}/${pick.name}`;
      const preview = `/api/preview/${SLUG}/${pick.name}`;
      const row = {
        file: pick.name,
        edited: pick.edited,
        thumbCold: await timedGet(server.base, auth, thumb),
        thumbWarm: await timedGet(server.base, auth, thumb),
        previewCold: await timedGet(server.base, auth, preview),
        previewWarm: await timedGet(server.base, auth, preview),
      };
      rows.push(row);
    }
    const summary = {
      apiRoot,
      rows,
      medianThumbColdMs: median(rows.map((row) => (row.thumbCold as { ms: number }).ms)),
      medianPreviewColdMs: median(rows.map((row) => (row.previewCold as { ms: number }).ms)),
    };
    console.log(jsonOutput ? JSON.stringify(summary) : JSON.stringify(summary, null, 2));
  } finally {
    server.child.kill();
    await server.child.exited;
    await rm(work.root, { recursive: true, force: true });
  }
}

await main();
