// fallow-ignore-file complexity code-duplication
/**
 * Thumbnail serving benchmark: boots the real server against a generated library whose photos
 * all have a fresh thumb, then times `GET /api/thumb/<slug>/<file>`.
 *
 *   bun scripts/bench-thumb-serving.ts [--api-root DIR] [--photos 2000] [--thumb-bytes 18000]
 *     [--indexed yes|no] [--runs 200] [--json] [--server-stderr] [--profile-dir DIR]
 *
 * Scenarios: sequential warm 200 and 304 latency, then the whole folder fetched at several
 * client concurrencies (the grid's pattern), with and without the `?v=` token.
 */
import { rm } from 'node:fs/promises';
import {
  apiRoot,
  bootServer,
  buildWorkspace,
  indexed,
  jsonOutput,
  median,
  photoCount,
  runs,
  SLUG,
  thumbBytes,
} from './bench-library-server.ts';

interface Listed {
  name: string;
  thumbVersion?: string;
}

async function fetchAll(
  base: string,
  headers: Record<string, string>,
  files: readonly Listed[],
  concurrency: number,
  versioned: boolean,
): Promise<{ totalMs: number; statuses: Record<number, number> }> {
  const statuses: Record<number, number> = {};
  const started = performance.now();
  let next = 0;
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (next < files.length) {
        const file = files[next++]!;
        const suffix = versioned && file.thumbVersion ? `?v=${file.thumbVersion}` : '';
        const response = await fetch(`${base}/api/thumb/${SLUG}/${file.name}${suffix}`, {
          headers,
        });
        await response.arrayBuffer();
        statuses[response.status] = (statuses[response.status] ?? 0) + 1;
      }
    }),
  );
  return { totalMs: performance.now() - started, statuses };
}

async function sequential(
  base: string,
  headers: Record<string, string>,
  files: readonly Listed[],
  conditional: boolean,
): Promise<{ min: number; median: number; status: number }> {
  const timings: number[] = [];
  const tags = new Map<string, string>();
  const sample = files.slice(0, runs);
  for (const file of sample) {
    const response = await fetch(`${base}/api/thumb/${SLUG}/${file.name}`, { headers });
    await response.arrayBuffer();
    tags.set(file.name, response.headers.get('etag') ?? '');
  }
  let status = 0;
  for (const file of sample) {
    const requestHeaders = conditional
      ? { ...headers, 'If-None-Match': tags.get(file.name) ?? '' }
      : headers;
    const started = performance.now();
    const response = await fetch(`${base}/api/thumb/${SLUG}/${file.name}`, {
      headers: requestHeaders,
    });
    await response.arrayBuffer();
    timings.push(performance.now() - started);
    status = response.status;
  }
  return { min: Math.min(...timings), median: median(timings), status };
}

async function main() {
  const work = await buildWorkspace();
  const server = await bootServer(work);
  try {
    const auth = { Authorization: `Bearer ${server.token}` };
    const listing = (await fetch(`${server.base}/api/folder/${SLUG}`, { headers: auth }).then((r) =>
      r.json(),
    )) as { images: Listed[] };
    const files = listing.images;
    const result: Record<string, unknown> = {
      apiRoot,
      photos: photoCount,
      indexed,
      thumbBytes,
      versionedInListing: files.filter((file) => file.thumbVersion).length,
    };
    result.warm200 = await sequential(server.base, auth, files, false);
    result.conditional304 = await sequential(server.base, auth, files, true);
    const whole: Record<string, unknown> = {};
    for (const concurrency of [1, 6, 32]) {
      const run = await fetchAll(server.base, auth, files, concurrency, false);
      whole[`c${concurrency}`] = { totalMs: Math.round(run.totalMs), statuses: run.statuses };
    }
    const versioned = await fetchAll(server.base, auth, files, 32, true);
    whole.c32Versioned = { totalMs: Math.round(versioned.totalMs), statuses: versioned.statuses };
    result.wholeFolder = whole;
    console.log(jsonOutput ? JSON.stringify(result) : JSON.stringify(result, null, 2));
  } finally {
    server.child.kill();
    await server.child.exited;
    await rm(work.root, { recursive: true, force: true });
  }
}

await main();
