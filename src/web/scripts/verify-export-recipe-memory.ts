/** Run against a built Hosted artifact and an explicit >32 MP synthetic RAW.
 * This qualifies deterministic rejection/recovery and capped encoding, not camera color quality.
 * Usage: bun scripts/verify-export-recipe-memory.ts /path/to/100mp.dng [dist/browser] [cap=2048]
 */
import { chromium } from '@playwright/test';
import { strict as assert } from 'node:assert';
import { readdirSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { hashFixture } from './lib/hash-fixture';

const fixture = process.argv[2];
if (!fixture)
  throw new Error('Pass an explicit large synthetic RAW fixture; this gate never skips.');
const dist = resolve(process.argv[3] ?? 'dist/maple-syrup/browser');
const cap = Number(process.argv[4] ?? 2048);
assert.ok(Number.isInteger(cap) && cap > 0, 'The test output cap must be a positive integer');
const worker = await exportWorker(dist);
const originalHash = await hashFixture(fixture);
const headers = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
};
const server = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === '/')
      return new Response('<!doctype html><title>Export memory gate</title>', {
        headers: { ...headers, 'Content-Type': 'text/html' },
      });
    if (path === '/fixture.dng') return new Response(Bun.file(fixture), { headers });
    const file = resolve(dist, `.${path}`);
    return file.startsWith(dist + sep)
      ? new Response(Bun.file(file), { headers })
      : new Response(null, { status: 403 });
  },
});
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const page = await browser.newPage();
  await page.goto(server.url.href);
  const result = await page.evaluate(
    async ({ workerPath, cap }) => {
      const source = await (await fetch('/fixture.dng')).arrayBuffer();
      const instance = new Worker(workerPath, { type: 'module' });
      const send = (id: number, maxSidePixels: number) =>
        new Promise<any>((resolve, reject) => {
          const timeout = setTimeout(() => reject(new Error('Export timed out')), 180_000);
          instance.onmessage = (event) => {
            if (event.data.id !== id) return;
            clearTimeout(timeout);
            resolve(event.data);
          };
          instance.onerror = (event) => {
            clearTimeout(timeout);
            reject(new Error(event.message));
          };
          const bytes = source.slice(0);
          instance.postMessage(
            {
              id,
              type: 'export',
              bytes,
              ext: 'dng',
              options: {
                format: 'jpeg',
                quality: 92,
                colorSpace: 'srgb',
                maxSidePixels,
              },
            },
            [bytes],
          );
        });
      try {
        // Intentionally post before status/init: a cold Browse batch has no editor decode first.
        const start = performance.now();
        const rejected = await send(1, 0);
        const rejectMs = performance.now() - start;
        const small = await send(2, cap);
        if (small.type !== 'export-success') throw new Error(small.message);
        const bitmap = await createImageBitmap(small.blob);
        const dimensions = { width: bitmap.width, height: bitmap.height };
        bitmap.close();
        const prefix = new TextDecoder('latin1').decode(
          await small.blob.slice(0, 20000).arrayBuffer(),
        );
        return {
          rejected,
          rejectMs,
          ...dimensions,
          byteLength: small.blob.size,
          hasIcc: prefix.includes('ICC_PROFILE'),
          totalMs: performance.now() - start,
        };
      } finally {
        instance.terminate();
      }
    },
    { workerPath: `/${worker}`, cap },
  );
  assert.equal(result.rejected.type, 'export-error');
  assert.match(result.rejected.message, /4 GiB memory budget/);
  assert.notEqual(result.rejected.fatal, true);
  assert.equal(Math.max(result.width, result.height), cap);
  assert.ok(result.hasIcc, 'The decoded JPEG must retain its output ICC profile');
  assert.equal(await hashFixture(fixture), originalHash, 'Export changed original bytes');
  console.log(JSON.stringify({ fixture, originalHash, ...result }, null, 2));
} finally {
  await browser.close();
  await server.stop();
}

async function exportWorker(directory: string): Promise<string> {
  const candidates: string[] = [];
  for (const name of readdirSync(directory).filter((file) => /^worker-.*\.js$/.test(file))) {
    if ((await Bun.file(resolve(directory, name)).text()).includes('"export-success"'))
      candidates.push(name);
  }
  assert.equal(candidates.length, 1, 'Expected one built production export worker');
  return candidates[0];
}
