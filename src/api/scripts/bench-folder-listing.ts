// fallow-ignore-file complexity code-duplication
/**
 * Folder listing benchmark: boots the real server against a generated library and times
 * `GET /api/folder/<slug>`.
 *
 *   bun scripts/bench-folder-listing.ts [--api-root DIR] [--photos 2000] [--sidecars 1000]
 *     [--indexed yes|no] [--thumbs yes|no] [--runs 15] [--json] [--profile-dir DIR] [--server-stderr]
 *     [--edge] [--dump FILE]
 *
 * Scenarios: cold first request, warm 200, 304 revalidation, `?limit=500` page, and wire size
 * under identity, gzip and brotli. `--edge` adds symlinked, escaping, dangling and directory
 * entries; `--dump` writes the identity body (root path normalised) so two trees can be diffed.
 */
import { rm, writeFile } from 'node:fs/promises';
import {
  apiRoot,
  bootServer,
  buildWorkspace,
  dumpFile,
  indexed,
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

async function main() {
  const work = await buildWorkspace();
  const server = await bootServer(work);
  try {
    const auth = { Authorization: `Bearer ${server.token}` };
    const url = `${server.base}/api/folder/${SLUG}`;
    const brotli = { ...auth, 'Accept-Encoding': 'br' };
    const result: Record<string, unknown> = {
      apiRoot,
      photos: photoCount,
      sidecars: sidecarCount,
      indexed,
      withThumbs,
    };
    const cold = await timed(url, brotli);
    result.cold = { wallMs: cold.wallMs, serverMs: cold.serverMs, bytes: cold.bytes };
    const warm: Sample[] = [];
    for (let i = 0; i < runs; i++) warm.push(await timed(url, brotli));
    result.warm = summarize(warm);
    const revalidate: Sample[] = [];
    for (let i = 0; i < runs; i++) {
      revalidate.push(await timed(url, { ...brotli, 'If-None-Match': cold.etag ?? '' }));
    }
    result.revalidate304 = summarize(revalidate);
    const page: Sample[] = [];
    for (let i = 0; i < runs; i++) page.push(await timed(`${url}?limit=500`, brotli));
    result.limit500 = summarize(page);
    const wire: Record<string, number> = {};
    for (const encoding of ['identity', 'gzip', 'br']) {
      wire[encoding] = (await timed(url, { ...auth, 'Accept-Encoding': encoding })).bytes;
    }
    result.wireBytes = wire;
    const body = await fetch(url, { headers: auth }).then((r) => r.text());
    result.imagesListed = (JSON.parse(body) as { images: unknown[] }).images.length;
    if (dumpFile)
      await writeFile(
        dumpFile,
        body.replaceAll(`/private${work.root}`, '<ROOT>').replaceAll(work.root, '<ROOT>'),
      );
    console.log(jsonOutput ? JSON.stringify(result) : JSON.stringify(result, null, 2));
  } finally {
    server.child.kill();
    await server.child.exited;
    await rm(work.root, { recursive: true, force: true });
  }
}

await main();
