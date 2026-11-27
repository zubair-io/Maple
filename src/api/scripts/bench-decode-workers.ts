// fallow-ignore-file complexity code-duplication
/**
 * Cold-folder thumbnail benchmark for the native decode worker count. For each requested worker
 * count it boots the real server against fresh APFS clones of the RAW fixtures, sets the RAW
 * decode lane to that size through `PATCH /api/workers/performance`, requests every thumbnail
 * with bounded client concurrency, and samples the resident memory of the whole server process
 * tree every 200 ms.
 *
 *   bun scripts/bench-decode-workers.ts --scenario unedited|edited --workers 1,2,4
 *     [--concurrency 8] [--copies 3] [--files 12] [--fixtures DIR] [--api-root DIR]
 *
 * `--concurrency 0` means unbounded. One JSON line per worker count is printed.
 */
const argv = Bun.argv;
for (const [name, value] of [
  ['--photos', '0'],
  ['--thumbs', 'no'],
  ['--indexed', 'no'],
] as const) {
  if (!argv.includes(name)) argv.push(name, value);
}
const { Database } = await import('bun:sqlite');
const { readdirSync, statSync } = await import('node:fs');
const { constants, copyFile, mkdir, readFile, rm, writeFile } = await import('node:fs/promises');
const { basename, extname, join } = await import('node:path');
const { FOLDER_ID, apiRoot, bootServer, buildWorkspace, flag, median, SLUG } =
  await import('./bench-library-server.ts');

const RAW_EXT = new Set(['.dng', '.cr2', '.cr3', '.nef', '.arw', '.raf', '.fff', '.raw', '.x3f']);
const MIN_RAW_BYTES = 500_000;
const DEVELOP_SIZE_CEILING_BYTES = 100_000_000;
const fixtureDir = flag('fixtures', join(import.meta.dir, '../../../test-fixtures/raws'));
const scenario = flag('scenario', 'unedited');
const workerCounts = flag('workers', '1,2,4').split(',').map(Number);
const concurrency = Number(flag('concurrency', '8'));
const copies = Number(flag('copies', '3'));
const editedFileCount = Number(flag('files', '12'));
const EDITED_SIDECAR = `<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
<rdf:Description rdf:about="" xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/" xmlns:papp="http://ns.justmaple.app/photo/1.0/"
 crs:Version="15.4" crs:ProcessVersion="11.0" crs:HasSettings="True" crs:Exposure2012="+0.50" crs:Contrast2012="12" papp:Profile="Auto"/>
</rdf:RDF></x:xmpmeta>
<?xpacket end="w"?>
`;

interface ProcRow {
  pid: number;
  ppid: number;
  rssKb: number;
}

async function processTable(): Promise<ProcRow[]> {
  const out = await Bun.$`ps -axo pid=,ppid=,rss=`.text();
  return out
    .trim()
    .split('\n')
    .map((line) => {
      const [pid, ppid, rssKb] = line.trim().split(/\s+/).map(Number);
      return { pid: pid!, ppid: ppid!, rssKb: rssKb! };
    });
}

function descendants(table: ProcRow[], rootPid: number): ProcRow[] {
  const byParent = Map.groupBy(table, (row) => row.ppid);
  const found: ProcRow[] = [];
  const queue = [rootPid];
  while (queue.length > 0) {
    for (const child of byParent.get(queue.shift()!) ?? []) {
      found.push(child);
      queue.push(child.pid);
    }
  }
  return found;
}

interface TreeSample {
  totalMb: number;
  serverMb: number;
  largestChildMb: number;
  children: number;
}

async function sampleTree(rootPid: number): Promise<TreeSample> {
  const table = await processTable();
  const kids = descendants(table, rootPid);
  const root = table.find((row) => row.pid === rootPid);
  const toMb = (kb: number) => kb / 1024;
  return {
    totalMb: toMb(kids.reduce((sum, row) => sum + row.rssKb, root?.rssKb ?? 0)),
    serverMb: toMb(root?.rssKb ?? 0),
    largestChildMb: toMb(Math.max(0, ...kids.map((row) => row.rssKb))),
    children: kids.length,
  };
}

function startSampler(rootPid: number) {
  const samples: TreeSample[] = [];
  const state = { running: true };
  const loop = (async () => {
    while (state.running) {
      samples.push(await sampleTree(rootPid));
      await Bun.sleep(200);
    }
  })();
  return {
    async stop() {
      state.running = false;
      await loop;
      return {
        peakTotalMb: Math.max(...samples.map((s) => s.totalMb)),
        peakLargestChildMb: Math.max(...samples.map((s) => s.largestChildMb)),
        peakServerMb: Math.max(...samples.map((s) => s.serverMb)),
        peakChildren: Math.max(...samples.map((s) => s.children)),
        sampleCount: samples.length,
      };
    },
  };
}

function pickFixtures(): string[] {
  const all = readdirSync(fixtureDir)
    .filter(
      (name) =>
        RAW_EXT.has(extname(name).toLowerCase()) &&
        statSync(join(fixtureDir, name)).size > MIN_RAW_BYTES,
    )
    .sort();
  if (scenario === 'unedited') return all;
  const developable = all.filter(
    (name) => statSync(join(fixtureDir, name)).size < DEVELOP_SIZE_CEILING_BYTES,
  );
  const step = developable.length / editedFileCount;
  return Array.from({ length: editedFileCount }, (_, i) => developable[Math.floor(i * step)]!);
}

interface Clone {
  name: string;
  source: string;
}

function cloneNames(sources: string[]): Clone[] {
  const perSource = scenario === 'unedited' ? copies : 1;
  return sources.flatMap((source) =>
    Array.from({ length: perSource }, (_, k) => {
      const ext = extname(source);
      return { source, name: `${basename(source, ext)}_c${k}${ext}` };
    }),
  );
}

async function timedGet(base: string, headers: Record<string, string>, path: string) {
  const started = performance.now();
  const response = await fetch(`${base}${path}`, { headers });
  await response.arrayBuffer();
  return { ms: performance.now() - started, status: response.status };
}

async function runWithConcurrency<T>(
  items: string[],
  limit: number,
  task: (item: string) => Promise<T>,
): Promise<T[]> {
  const results: T[] = [];
  const cursor = { next: 0 };
  const lanes = limit <= 0 ? items.length : Math.min(limit, items.length);
  await Promise.all(
    Array.from({ length: lanes }, async () => {
      while (cursor.next < items.length) {
        const index = cursor.next++;
        results[index] = await task(items[index]!);
      }
    }),
  );
  return results;
}

async function populateLibrary(work: { library: string; sqlitePath: string }, clones: Clone[]) {
  await mkdir(work.library, { recursive: true });
  await Promise.all(
    clones.map(async (clone) => {
      const target = join(work.library, clone.name);
      await copyFile(join(fixtureDir, clone.source), target, constants.COPYFILE_FICLONE);
      await readFile(target);
      if (scenario === 'edited') {
        const stem = basename(clone.name, extname(clone.name));
        await writeFile(join(work.library, `${stem}.xmp`), EDITED_SIDECAR);
      }
    }),
  );
  const db = new Database(work.sqlitePath);
  clones.forEach((clone, i) => {
    const id = `65c${String(i).padStart(21, '0')}`;
    db.run(
      `INSERT INTO assets (id, maple_id, size, mtime, indexed_at, exif, media_kind)
       VALUES (?, ?, 1, ?, ?, '{}', 'image')`,
      [id, `${(i + 1).toString(16).padStart(16, '0')}`, Date.now(), new Date().toISOString()],
    );
    db.run(
      `INSERT INTO asset_locations (asset_id, ordinal, library_id, path, filename) VALUES (?, 0, ?, '', ?)`,
      [id, FOLDER_ID, clone.name],
    );
  });
  db.close();
}

async function runOnce(workers: number, clones: Clone[]) {
  const work = await buildWorkspace();
  try {
    await populateLibrary(work, clones);
    return await measureServer(await bootServer(work), workers, clones);
  } finally {
    await rm(work.root, { recursive: true, force: true });
  }
}

async function measureServer(
  server: Awaited<ReturnType<typeof bootServer>>,
  workers: number,
  clones: Clone[],
) {
  const rootPid = server.child.pid;
  try {
    const auth = { Authorization: `Bearer ${server.token}` };
    const patch = await fetch(`${server.base}/api/workers/performance`, {
      method: 'PATCH',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ffi_workers: workers }),
    });
    await Bun.sleep(4000);
    const idle = await sampleTree(rootPid);
    const sampler = startSampler(rootPid);
    const started = performance.now();
    const results = await runWithConcurrency(
      clones.map((clone) => clone.name),
      concurrency,
      (name) => timedGet(server.base, auth, `/api/thumb/${SLUG}/${name}`),
    );
    const wallMs = performance.now() - started;
    const memory = await sampler.stop();
    const stats = (await fetch(`${server.base}/api/workers/performance`, { headers: auth })
      .then((r) => r.json())
      .catch(() => null)) as { pool?: unknown } | null;
    const latencies = results.map((r) => r.ms);
    return {
      scenario,
      workers,
      concurrency: concurrency <= 0 ? 'unbounded' : concurrency,
      patchStatus: patch.status,
      poolAfter: stats?.pool ?? null,
      files: clones.length,
      wallSeconds: Number((wallMs / 1000).toFixed(2)),
      thumbsPerSecond: Number((clones.length / (wallMs / 1000)).toFixed(3)),
      non200: results.filter((r) => r.status !== 200).length,
      statuses: Object.fromEntries(
        Map.groupBy(results, (r) => r.status)
          .entries()
          .map(([status, rows]) => [status, rows.length]),
      ),
      latencyMedianMs: Math.round(median(latencies)),
      latencyMaxMs: Math.round(Math.max(...latencies)),
      idleTotalMb: Math.round(idle.totalMb),
      idleServerMb: Math.round(idle.serverMb),
      idleProcesses: idle.children + 1,
      peakTotalMb: Math.round(memory.peakTotalMb),
      peakLargestChildMb: Math.round(memory.peakLargestChildMb),
      peakServerMb: Math.round(memory.peakServerMb),
      peakChildren: memory.peakChildren,
      memorySamples: memory.sampleCount,
    };
  } finally {
    const leftovers = descendants(await processTable(), rootPid).map((row) => row.pid);
    server.child.kill();
    await server.child.exited;
    for (const pid of leftovers) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // already gone
      }
    }
  }
}

const clones = cloneNames(pickFixtures());
for (const workers of workerCounts) {
  console.log(JSON.stringify({ apiRoot, ...(await runOnce(workers, clones)) }));
  await Bun.sleep(3000);
}
