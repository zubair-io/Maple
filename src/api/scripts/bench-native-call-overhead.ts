// fallow-ignore-file complexity code-duplication
/**
 * What the server adds around the native thumbnail render, and what one pool round trip costs.
 *
 *   bun scripts/bench-native-call-overhead.ts --fixtures DIR [--files 6] [--rounds 5] [--pings 300]
 *     [--api-root DIR]
 *
 * For each unedited RAW and round it times, in a rotating order so no variant is always first:
 *   in-process: the native thumbnail render called directly in this process (no child, no IPC)
 *   pool:       the same render through the decode pool (child process, IPC)
 *   pool+check: the pool render plus the AVIF validation the route performs after it
 *   route:      `GET /api/thumb` against the real server with no thumb on disk
 * Then it times a trivial pool request (a sidecar parse) against the same parse called in-process,
 * which isolates the per-call IPC cost. One JSON line per measurement is printed.
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
const { constants, copyFile, mkdir, readFile, rm } = await import('node:fs/promises');
const { extname, join } = await import('node:path');
const { FOLDER_ID, apiRoot, bootServer, buildWorkspace, flag, median, SLUG } =
  await import('./bench-library-server.ts');

process.env.MAPLE_NATIVE_LIB ??= join(apiRoot, 'native', `libraw_ffi.${suffix}`);

const RAW_EXT = new Set(['.dng', '.cr2', '.cr3', '.nef', '.arw', '.raf', '.fff', '.raw', '.x3f']);
const fixtureDir = flag('fixtures', join(import.meta.dir, '../../../test-fixtures/raws'));
const fileCount = Number(flag('files', '6'));
const rounds = Number(flag('rounds', '5'));
const pings = Number(flag('pings', '300'));
const THUMB_PX = 512;
const THUMB_QUALITY = 55;
const TINY_SIDECAR = `<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
<rdf:Description rdf:about="" xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/" crs:Exposure2012="+0.50"/>
</rdf:RDF></x:xmpmeta>
<?xpacket end="w"?>
`;

const ms = (since: number) => Number((performance.now() - since).toFixed(2));
const timeIt = async <T>(fn: () => Promise<T> | T) => {
  const started = performance.now();
  await fn();
  return ms(started);
};

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

const VARIANTS = ['inprocess', 'pool', 'poolCheck', 'route'] as const;
type Variant = (typeof VARIANTS)[number];

async function populateLibrary(work: { library: string; sqlitePath: string }, names: string[]) {
  await mkdir(work.library, { recursive: true });
  await Promise.all(
    names.map(async (name) => {
      const target = join(work.library, name);
      await copyFile(join(fixtureDir, name), target, constants.COPYFILE_FICLONE);
      await readFile(target);
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

async function main() {
  const names = pickFixtures();
  const work = await buildWorkspace();
  const cleanups: Array<() => Promise<unknown> | unknown> = [
    () => rm(work.root, { recursive: true, force: true }),
  ];
  try {
    await populateLibrary(work, names);
    const { ffiPool } = await import(join(apiRoot, 'src/ffi/ffi-pool.ts'));
    const { tryGetRawFfi } = await import(join(apiRoot, 'src/ffi/raw_ffi.ts'));
    const ffi = tryGetRawFfi();
    if (!ffi) throw new Error('native library did not load in-process');
    const pool = ffiPool();
    cleanups.push(() => pool.shutdown());
    const server = await bootServer(work);
    cleanups.push(async () => {
      server.child.kill();
      await server.child.exited;
    });
    const scratch = join(work.root, 'direct');
    await mkdir(scratch, { recursive: true });
    const auth = { Authorization: `Bearer ${server.token}` };
    await fetch(`${server.base}/api/workers/performance`, {
      method: 'PATCH',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ffi_workers: 1 }),
    });
    await Bun.sleep(3000);
    const clearRouteThumbs = async () => {
      await rm(join(work.library, '.maple'), { recursive: true, force: true });
      await mkdir(join(work.library, '.maple', 'thumbs'), { recursive: true });
    };
    const runVariant = async (variant: Variant, name: string): Promise<number> => {
      const raw = join(work.library, name);
      const out = join(scratch, `${variant}.avif`);
      await rm(out, { force: true });
      if (variant === 'inprocess') {
        return timeIt(() => ffi.renderThumbnailAvifToFile(raw, out, THUMB_PX, THUMB_QUALITY));
      }
      if (variant === 'pool') {
        return timeIt(() => pool.renderThumbnailAvifToFile(raw, out, THUMB_PX, THUMB_QUALITY));
      }
      if (variant === 'poolCheck') {
        return timeIt(async () => {
          await pool.renderThumbnailAvifToFile(raw, out, THUMB_PX, THUMB_QUALITY);
          await pool.validateAvif(out, THUMB_PX);
        });
      }
      await clearRouteThumbs();
      return timeIt(async () => {
        const response = await fetch(`${server.base}/api/thumb/${SLUG}/${name}`, {
          headers: auth,
        });
        await response.arrayBuffer();
        if (response.status !== 200) throw new Error(`route answered ${response.status}`);
      });
    };

    const warmName = names[0]!;
    for (const variant of VARIANTS) await runVariant(variant, warmName);

    const perFile = new Map<string, Record<Variant, number[]>>();
    for (const name of names) {
      perFile.set(name, { inprocess: [], pool: [], poolCheck: [], route: [] });
    }
    for (let round = 0; round < rounds; round++) {
      const order = [...VARIANTS.slice(round % 4), ...VARIANTS.slice(0, round % 4)];
      for (const name of names) {
        for (const variant of order) {
          const elapsed = await runVariant(variant, name);
          perFile.get(name)![variant].push(elapsed);
          console.log(
            JSON.stringify({ part: 'overhead', round, file: name, variant, ms: elapsed }),
          );
        }
      }
    }
    for (const [file, samples] of perFile) {
      const row = Object.fromEntries(
        VARIANTS.map((v) => [v, { min: Math.min(...samples[v]), median: median(samples[v]) }]),
      );
      console.log(JSON.stringify({ part: 'overhead-summary', file, ...row }));
    }

    const inProcessPings: number[] = [];
    const poolPings: number[] = [];
    await pool.sidecarHasRenderAdjustments(TINY_SIDECAR);
    for (let i = 0; i < pings; i++) {
      inProcessPings.push(await timeIt(() => ffi.xmpHasRenderAdjustments?.(TINY_SIDECAR)));
      poolPings.push(await timeIt(() => pool.sidecarHasRenderAdjustments(TINY_SIDECAR)));
    }
    const sorted = (values: number[]) => [...values].sort((a, b) => a - b);
    const p95 = (values: number[]) => sorted(values)[Math.floor(values.length * 0.95)]!;
    console.log(
      JSON.stringify({
        part: 'ping',
        request: 'sidecarHasRenderAdjustments (bitmap lane, parse of a 400-byte document)',
        pings,
        inProcessMs: {
          min: Math.min(...inProcessPings),
          median: median(inProcessPings),
          p95: p95(inProcessPings),
        },
        poolMs: { min: Math.min(...poolPings), median: median(poolPings), p95: p95(poolPings) },
      }),
    );
    const tiny = join(fixtureDir, 'test_0018.dng');
    const rawPings: number[] = [];
    const rawInProcess: number[] = [];
    await pool.asShotWhiteBalance(tiny).catch(() => null);
    for (let i = 0; i < Math.min(pings, 60); i++) {
      rawInProcess.push(await timeIt(() => ffi.asShotWhiteBalance(tiny)));
      rawPings.push(await timeIt(() => pool.asShotWhiteBalance(tiny).catch(() => null)));
    }
    console.log(
      JSON.stringify({
        part: 'ping-raw-lane',
        request: 'asShotWhiteBalance on test_0018.dng (950 KB RAW)',
        inProcessMs: { min: Math.min(...rawInProcess), median: median(rawInProcess) },
        poolMs: { min: Math.min(...rawPings), median: median(rawPings) },
      }),
    );
  } finally {
    for (const cleanup of cleanups.toReversed()) await cleanup();
  }
}

await main();
