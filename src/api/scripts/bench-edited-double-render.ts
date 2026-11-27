// fallow-ignore-file complexity code-duplication
/**
 * How much of an edited RAW's thumbnail + preview cost is the repeated RAW develop.
 *
 *   bun scripts/bench-edited-double-render.ts --fixtures DIR [--files 8] [--reps 2] [--parts AB] [--api-root DIR]
 *
 * Part A boots the real server (one decode worker) against clones of edited RAWs and times
 * `GET /api/thumb` then `GET /api/preview`, cold, one file at a time.
 * Part B calls the same pool entry points the thumbnail and preview code use, in this process,
 * and times each stage: sidecar develop to JPEG (`exportRecipeToFile`, the call
 * `renderRawSidecarDerivative` makes), the JPEG to AVIF hop (`renderBitmapThumbToFile`), the AVIF
 * validation, plus `renderDevelopJpegToFile` and `computeHistogram` as proxies for the develop
 * without the JPEG recipe encoder. It also times the JPEG decode and AVIF/JPEG encode of the
 * developed output with the `maple` image library, to split the bitmap hop.
 * One JSON line per measurement is printed.
 */
const argv = Bun.argv;
for (const [name, value] of [
  ['--photos', '0'],
  ['--thumbs', 'no'],
  ['--indexed', 'no'],
] as const) {
  if (!argv.includes(name)) argv.push(name, value);
}
const { suffix } = await import('bun:ffi');
const { Database } = await import('bun:sqlite');
const { readdirSync, statSync } = await import('node:fs');
const { constants, copyFile, mkdir, readFile, rm, writeFile } = await import('node:fs/promises');
const { tmpdir } = await import('node:os');
const { basename, extname, join } = await import('node:path');
const { FOLDER_ID, apiRoot, bootServer, buildWorkspace, flag, SLUG } =
  await import('./bench-library-server.ts');

process.env.MAPLE_NATIVE_LIB ??= join(apiRoot, 'native', `libraw_ffi.${suffix}`);

const RAW_EXT = new Set(['.dng', '.cr2', '.cr3', '.nef', '.arw', '.raf', '.fff', '.raw', '.x3f']);
const fixtureDir = flag('fixtures', join(import.meta.dir, '../../../test-fixtures/raws'));
const fileCount = Number(flag('files', '8'));
const reps = Number(flag('reps', '2'));
const THUMB_PX = 512;
const PREVIEW_PX = 1280;
const SIDECAR = `<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
<rdf:Description rdf:about="" xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/" xmlns:papp="http://ns.justmaple.app/photo/1.0/"
 crs:Version="15.4" crs:ProcessVersion="11.0" crs:HasSettings="True" crs:Exposure2012="+0.50" crs:Contrast2012="12" papp:Profile="Auto"/>
</rdf:RDF></x:xmpmeta>
<?xpacket end="w"?>
`;

function pickFixtures(): string[] {
  const all = readdirSync(fixtureDir)
    .filter((name) => RAW_EXT.has(extname(name).toLowerCase()))
    .filter((name) => {
      const size = statSync(join(fixtureDir, name)).size;
      return size > 5_000_000 && size < 100_000_000;
    })
    .sort();
  const step = all.length / fileCount;
  return Array.from({ length: fileCount }, (_, i) => all[Math.floor(i * step)]!);
}

const ms = (since: number) => Number((performance.now() - since).toFixed(1));

async function timedGet(base: string, headers: Record<string, string>, path: string) {
  const started = performance.now();
  const response = await fetch(`${base}${path}`, { headers });
  await response.arrayBuffer();
  return { ms: ms(started), status: response.status };
}

async function populateLibrary(work: { library: string; sqlitePath: string }, names: string[]) {
  await mkdir(work.library, { recursive: true });
  await Promise.all(
    names.map(async (name) => {
      const target = join(work.library, name);
      await copyFile(join(fixtureDir, name), target, constants.COPYFILE_FICLONE);
      await readFile(target);
      await writeFile(join(work.library, `${basename(name, extname(name))}.xmp`), SIDECAR);
    }),
  );
  const db = new Database(work.sqlitePath);
  names.forEach((name, i) => {
    const id = `65c${String(i).padStart(21, '0')}`;
    db.run(
      `INSERT INTO assets (id, maple_id, size, mtime, indexed_at, exif, media_kind)
       VALUES (?, ?, 1, ?, ?, '{}', 'image')`,
      [id, `${(i + 1).toString(16).padStart(16, '0')}`, Date.now(), new Date().toISOString()],
    );
    db.run(
      `INSERT INTO asset_locations (asset_id, ordinal, library_id, path, filename) VALUES (?, 0, ?, '', ?)`,
      [id, FOLDER_ID, name],
    );
  });
  db.close();
}

async function partA(names: string[]) {
  const work = await buildWorkspace();
  try {
    await populateLibrary(work, names);
    await timeServer(await bootServer(work), work.library, names);
  } finally {
    await rm(work.root, { recursive: true, force: true });
  }
}

async function timeServer(
  server: Awaited<ReturnType<typeof bootServer>>,
  library: string,
  names: string[],
) {
  try {
    const auth = { Authorization: `Bearer ${server.token}` };
    await fetch(`${server.base}/api/workers/performance`, {
      method: 'PATCH',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ffi_workers: 1 }),
    });
    await Bun.sleep(3000);
    const wake = names[0]!;
    await timedGet(server.base, auth, `/api/thumb/${SLUG}/${wake}`);
    await timedGet(server.base, auth, `/api/preview/${SLUG}/${wake}`);
    await rm(join(library, '.maple'), { recursive: true, force: true });
    await mkdir(join(library, '.maple', 'thumbs'), { recursive: true });
    for (let rep = 0; rep < reps; rep++) {
      for (const name of names) {
        const thumb = await timedGet(server.base, auth, `/api/thumb/${SLUG}/${name}`);
        const preview = await timedGet(server.base, auth, `/api/preview/${SLUG}/${name}`);
        console.log(
          JSON.stringify({
            part: 'A',
            rep,
            file: name,
            thumbMs: thumb.ms,
            previewMs: preview.ms,
            sumMs: Number((thumb.ms + preview.ms).toFixed(1)),
            statuses: [thumb.status, preview.status],
          }),
        );
        await rm(join(library, '.maple'), { recursive: true, force: true });
        await mkdir(join(library, '.maple', 'thumbs'), { recursive: true });
      }
    }
  } finally {
    server.child.kill();
    await server.child.exited;
  }
}

async function partB(names: string[]) {
  const { ffiPool } = await import(join(apiRoot, 'src/ffi/ffi-pool.ts'));
  const { filmLutDirectory } = await import(join(apiRoot, 'src/ffi/film-lut-directory.ts'));
  const { DEFAULT_EXPORT_RECIPE } = await import(
    join(apiRoot, 'src/generated/export-recipe.generated.ts')
  );
  const { maple } = await import(join(apiRoot, 'node_modules/maple'));
  const pool = ffiPool();
  pool.setPoolSize(1);
  const dir = join(tmpdir(), `maple-double-render-${process.pid}`);
  await mkdir(dir, { recursive: true });
  const film = await filmLutDirectory();
  const inside = (px: number) => ({
    width: px,
    height: px,
    fit: 'inside' as const,
    withoutEnlargement: true,
  });
  const stage = async <T>(fn: () => Promise<T>) => {
    const started = performance.now();
    const value = await fn();
    return { value, ms: ms(started) };
  };
  try {
    const warmRaw = join(dir, 'warm.dng');
    await copyFile(join(fixtureDir, names[0]!), warmRaw, constants.COPYFILE_FICLONE);
    await pool.exportRecipeToFile(
      warmRaw,
      SIDECAR,
      JSON.stringify({ ...DEFAULT_EXPORT_RECIPE, quality: 90, maxLongEdge: THUMB_PX }),
      film,
      join(dir, 'warm.jpg'),
    );
    for (let rep = 0; rep < reps; rep++) {
      for (const name of names) {
        const raw = join(dir, name);
        await copyFile(join(fixtureDir, name), raw, constants.COPYFILE_FICLONE);
        await readFile(raw);
        const xmpPath = join(dir, `${basename(name, extname(name))}.xmp`);
        await writeFile(xmpPath, SIDECAR);
        const row: Record<string, unknown> = { part: 'B', rep, file: name };
        for (const [label, px, quality] of [
          ['thumb', THUMB_PX, 55],
          ['preview', PREVIEW_PX, 70],
        ] as const) {
          const jpg = join(dir, `${label}.jpg`);
          const avif = join(dir, `${label}.avif`);
          await rm(jpg, { force: true });
          await rm(avif, { force: true });
          const recipe = JSON.stringify({ ...DEFAULT_EXPORT_RECIPE, quality: 90, maxLongEdge: px });
          row[`${label}DevelopToJpegMs`] = (
            await stage(() => pool.exportRecipeToFile(raw, SIDECAR, recipe, film, jpg))
          ).ms;
          row[`${label}JpegToAvifMs`] = (
            await stage(() => pool.renderBitmapThumbToFile(jpg, avif, px, quality, 'jpg'))
          ).ms;
          row[`${label}ValidateMs`] = (await stage(() => pool.validateAvif(avif, px))).ms;
          const proxyJpg = join(dir, `${label}-proxy.jpg`);
          await rm(proxyJpg, { force: true });
          row[`${label}DevelopJpegProxyMs`] = (
            await stage(() => pool.renderDevelopJpegToFile(raw, xmpPath, proxyJpg, px, 90))
          ).ms;
          const decoded = await stage(() => maple(jpg).rotate().resize(inside(px)).toRaw());
          row[`${label}JpegDecodeMs`] = decoded.ms;
          const { data, width, height } = decoded.value as {
            data: Buffer;
            width: number;
            height: number;
          };
          row[`${label}AvifEncodeMs`] = (
            await stage(() =>
              maple({ data, width, height, channels: 3 })
                .toFormat('avif', { quality, effort: 4 })
                .toBuffer(),
            )
          ).ms;
          row[`${label}JpegEncodeMs`] = (
            await stage(() =>
              maple({ data, width, height, channels: 3 })
                .toFormat('jpeg', { quality: 90 })
                .toBuffer(),
            )
          ).ms;
        }
        row.histogramMs = (await stage(() => pool.computeHistogram(raw, xmpPath))).ms;
        console.log(JSON.stringify(row));
        await rm(raw, { force: true });
      }
    }
  } finally {
    pool.shutdown();
    await rm(dir, { recursive: true, force: true });
  }
}

const names = pickFixtures().filter((name) => extname(name).toLowerCase() !== '.x3f');
const parts = flag('parts', 'AB');
console.log(JSON.stringify({ apiRoot, fixtures: names, reps }));
if (parts.includes('A')) await partA(names);
if (parts.includes('B')) await partB(names);
