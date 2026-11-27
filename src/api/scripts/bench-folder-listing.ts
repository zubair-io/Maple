// fallow-ignore-file complexity code-duplication
/**
 * Folder listing benchmark: boots the real server against a generated library and times
 * `GET /api/folder/<slug>`.
 *
 *   bun scripts/bench-folder-listing.ts [--api-root DIR] [--photos 2000] [--sidecars 1000]
 *     [--indexed yes|no] [--thumbs yes|no] [--runs 15] [--json] [--profile-dir DIR] [--server-stderr]
 *     [--edge] [--dump FILE] [--check] [--budget FILE]
 *
 * Scenarios: cold first request, warm 200, 304 revalidation, `?limit=500` page, and wire size
 * under identity, gzip and brotli. `--edge` adds symlinked, escaping, dangling and directory
 * entries; `--dump` writes the identity body (root path normalised) so two trees can be diffed.
 *
 * `--check` judges the medians against `folder-listing-budget.json` (or `--budget FILE`): the
 * product target on any machine, the recorded medians on the machine they were recorded on. It
 * exits 1 when one is over and 2 when the run cannot be judged (another scenario, an unreadable
 * budget, wrong responses, a failed benchmark, a machine with no entry). The committed budget is
 * for `--runs 30`.
 */
import { rm, writeFile } from 'node:fs/promises';
import {
  apiRoot,
  bootServer,
  buildWorkspace,
  dumpFile,
  flag,
  indexed,
  processCpuSeconds,
  jsonOutput,
  photoCount,
  runs,
  SLUG,
  sidecarCount,
  summarize,
  timed,
  withThumbs,
  type Sample,
} from './bench-library-server.ts';
import {
  DEFAULT_BUDGET_FILE,
  describeVerdict,
  judgeListing,
  machineKey,
  observeListing,
  readBudgetFile,
  scenarioProblem,
  verdictExitCode,
  type BudgetVerdict,
  type ListingBudgetFile,
  type ListingScenario,
} from './folder-listing-budget.ts';

const checkBudget = Bun.argv.includes('--check');
const scenario: ListingScenario = {
  photos: photoCount,
  sidecars: sidecarCount,
  indexed,
  withThumbs,
  runs,
};

type Server = Awaited<ReturnType<typeof bootServer>>;

/** The budget to judge against, or why this run cannot be judged, known before anything boots. */
async function budgetForCheck(): Promise<{ budget: ListingBudgetFile } | { problem: string }> {
  const named = flag('budget', '');
  if (Bun.argv.includes('--budget') && (named === '' || named.startsWith('--'))) {
    return { problem: '--budget needs a file' };
  }
  const read = await readBudgetFile(named === '' ? DEFAULT_BUDGET_FILE : named);
  if ('problem' in read) return read;
  const mismatch = scenarioProblem(read.budget, scenario);
  return mismatch === null ? read : { problem: mismatch };
}

function report(result: Record<string, unknown>, verdict: BudgetVerdict | null): void {
  const reported = verdict ? { ...result, budget: verdict } : result;
  console.log(jsonOutput ? JSON.stringify(reported) : JSON.stringify(reported, null, 2));
  if (!verdict) return;
  console.error(describeVerdict(verdict));
  process.exitCode = verdictExitCode(verdict);
}

function listedImages(body: string): number {
  try {
    const images = (JSON.parse(body) as { images?: unknown }).images;
    return Array.isArray(images) ? images.length : 0;
  } catch {
    return 0;
  }
}

interface Outcome {
  result: Record<string, unknown>;
  verdict: BudgetVerdict | null;
}

async function measure(
  server: Server,
  workRoot: string,
  budget: ListingBudgetFile | null,
): Promise<Outcome> {
  const auth = { Authorization: `Bearer ${server.token}` };
  const url = `${server.base}/api/folder/${SLUG}`;
  const brotli = { ...auth, 'Accept-Encoding': 'br' };
  const cold = await timed(url, brotli);
  const warm: Sample[] = [];
  const cpuBefore = await processCpuSeconds(server.child.pid);
  for (let i = 0; i < runs; i++) warm.push(await timed(url, brotli));
  const cpuAfter = await processCpuSeconds(server.child.pid);
  const revalidate: Sample[] = [];
  for (let i = 0; i < runs; i++) {
    revalidate.push(await timed(url, { ...brotli, 'If-None-Match': cold.etag ?? '' }));
  }
  const page: Sample[] = [];
  for (let i = 0; i < runs; i++) page.push(await timed(`${url}?limit=500`, brotli));
  const wire: Record<string, number> = {};
  for (const encoding of ['identity', 'gzip', 'br']) {
    wire[encoding] = (await timed(url, { ...auth, 'Accept-Encoding': encoding })).bytes;
  }
  const body = await fetch(url, { headers: auth }).then((r) => r.text());
  const imagesListed = listedImages(body);
  const pageImages = listedImages(
    await fetch(`${url}?limit=500`, { headers: auth }).then((r) => r.text()),
  );
  if (dumpFile)
    await writeFile(
      dumpFile,
      body.replaceAll(`/private${workRoot}`, '<ROOT>').replaceAll(workRoot, '<ROOT>'),
    );
  const observed = observeListing({ warm, revalidate, page }, { images: imagesListed, pageImages });
  const warmSummary = summarize(warm);
  const revalidateSummary = summarize(revalidate);
  const pageSummary = summarize(page);
  const result = {
    apiRoot,
    photos: photoCount,
    sidecars: sidecarCount,
    indexed,
    withThumbs,
    cold: { wallMs: cold.wallMs, serverMs: cold.serverMs, bytes: cold.bytes },
    warm: {
      ...warmSummary,
      serverCpuMsPerRequest: Number((((cpuAfter - cpuBefore) * 1000) / runs).toFixed(1)),
    },
    revalidate304: revalidateSummary,
    limit500: pageSummary,
    wireBytes: wire,
    imagesListed,
    responses: observed.responses,
  };
  const verdict = budget
    ? judgeListing(budget, machineKey(), scenario, observed.responses, observed.medians)
    : null;
  return { result, verdict };
}

const failed = (reason: string): Outcome => ({
  result: { ...scenario },
  verdict: { machine: machineKey(), rows: [], notJudged: reason },
});

async function run(budget: ListingBudgetFile | null): Promise<Outcome> {
  const work = await buildWorkspace();
  try {
    const server = await bootServer(work);
    try {
      return await measure(server, work.root, budget);
    } finally {
      server.child.kill();
      await server.child.exited;
    }
  } finally {
    await rm(work.root, { recursive: true, force: true });
  }
}

async function outcome(): Promise<Outcome> {
  if (!checkBudget) return run(null);
  const check = await budgetForCheck();
  if ('problem' in check) return failed(check.problem);
  return run(check.budget).catch((error: unknown) =>
    failed(`the benchmark failed: ${error instanceof Error ? error.message : String(error)}`),
  );
}

const { result, verdict } = await outcome();
report(result, verdict);
