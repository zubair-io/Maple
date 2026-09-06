/** Real production worker + IndexedDB + WASM export regression; no renderer mocks.
 * Build Hosted, then: bun scripts/check-cold-export-lens.ts [dist/maple-syrup/browser]
 * Uses the committed tiny grey DNG and authored LCPs; no camera corpus is required.
 */
import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { lensExportFixture, lensExportProfile } from './lib/cold-export-fixture';

const dist = resolve(process.argv[2] ?? 'dist/maple-syrup/browser');
const fixture = resolve('../apple/MapleUITests/Fixtures/synthetic/grey-l018-rggb.dng');
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const originalHash = hash(readFileSync(fixture));
const raw = lensExportFixture(fixture);
const workers: string[] = [];
for (const file of readdirSync(dist).filter((name) => /^worker-.*\.js$/.test(name))) {
  if ((await Bun.file(resolve(dist, file)).text()).includes('"export-success"')) workers.push(file);
}
assert.equal(workers.length, 1, 'Expected one built production RAW/export worker');
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
      return new Response('<!doctype html><title>Cold LCP export</title>', {
        headers: { ...headers, 'Content-Type': 'text/html' },
      });
    if (path === '/fixture.dng') return new Response(raw, { headers });
    const file = resolve(dist, `.${path}`);
    return file.startsWith(dist + sep)
      ? new Response(Bun.file(file), { headers })
      : new Response(null, { status: 403 });
  },
});
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const page = await browser.newPage();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(server.url.href);
  const result = await page.evaluate(
    async ({ workerPath, profileA, profileB }) => {
      const source = await (await fetch('/fixture.dng')).arrayBuffer();
      const workerClients: ReturnType<typeof client>[] = [];
      function client() {
        const worker = new Worker(workerPath, { type: 'module' });
        let id = 0;
        const fetched: string[] = [];
        const sent: string[] = [];
        const pending = new Map<
          number,
          {
            resolve: (value: any) => void;
            reject: (error: Error) => void;
            timer: ReturnType<typeof setTimeout>;
          }
        >();
        worker.onmessage = ({ data }) => {
          if (data.type === 'lens-profile-fetch') {
            fetched.push(data.reference);
            // Hosted has no server fallback. Preserve its real fetch/ack protocol.
            worker.postMessage({ id: data.id, type: 'lens-profile-restored' });
            return;
          }
          const request = pending.get(data.id);
          if (!request) return;
          clearTimeout(request.timer);
          pending.delete(data.id);
          request.resolve(data);
        };
        worker.onerror = ({ message }) => {
          for (const request of pending.values()) {
            clearTimeout(request.timer);
            request.reject(new Error(message));
          }
          pending.clear();
        };
        const send = (request: object & { type: string }): Promise<any> =>
          new Promise((resolve, reject) => {
            const requestId = ++id;
            const timer = setTimeout(() => reject(new Error(`Timed out: ${request.type}`)), 60_000);
            pending.set(requestId, { resolve, reject, timer });
            sent.push(request.type);
            const bytes = source.slice(0);
            worker.postMessage({ ...request, id: requestId, bytes, ext: 'dng' }, [bytes]);
          });
        const instance = { send, fetched, sent, close: () => worker.terminate() };
        workerClients.push(instance);
        return instance;
      }
      const xmp = (reference: string, extra = '') => `<x:xmpmeta xmlns:x="adobe:ns:meta/">
      <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description
        xmlns:papp="https://justmaple.app/ns/xmp/1.0/" xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/"
        papp:Profile="Neutral" papp:LensProfile="${reference}" ${extra}/></rdf:RDF></x:xmpmeta>`;
      const exportRequest = (snapshot: string) => ({
        type: 'export',
        xmp: snapshot,
        options: { format: 'png', quality: 100, colorSpace: 'srgb', maxSidePixels: 64 },
      });
      const pixels = async (reply: any) => {
        if (reply.type !== 'export-success') throw new Error(JSON.stringify(reply));
        const bitmap = await createImageBitmap(reply.blob);
        const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
        const context = canvas.getContext('2d')!;
        context.drawImage(bitmap, 0, 0);
        const rgba = context.getImageData(0, 0, bitmap.width, bitmap.height).data;
        const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', rgba)))
          .map((byte) => byte.toString(16).padStart(2, '0'))
          .join('');
        const dimensions = [bitmap.width, bitmap.height];
        bitmap.close();
        return { digest, dimensions, rgba: Array.from(rgba) };
      };
      const storedProfile = (reference: string, xml?: string) =>
        new Promise<void>((resolve, reject) => {
          const open = indexedDB.open('maple-lens-profiles', 1);
          open.onerror = () => reject(open.error);
          open.onsuccess = () => {
            const db = open.result;
            const tx = db.transaction('profiles', 'readwrite');
            const store = tx.objectStore('profiles');
            const digest = reference.split(':')[1];
            if (xml === undefined) store.delete(digest);
            else store.put(xml, digest);
            tx.oncomplete = () => {
              db.close();
              resolve();
            };
            tx.onerror = () => {
              db.close();
              reject(tx.error);
            };
          };
        });
      try {
        const importing = client();
        const importedA = await importing.send({ type: 'import-lens-profile', xml: profileA });
        if (importedA.type !== 'lens-profile-success') throw new Error(JSON.stringify(importedA));
        const referenceA: string = importedA.profile.reference;
        const queued = Object.freeze({ id: 'queued-photo', xmp: xmp(referenceA) });
        const warmA = await pixels(await importing.send(exportRequest(queued.xmp)));
        const importedB = await importing.send({ type: 'import-lens-profile', xml: profileB });
        if (importedB.type !== 'lens-profile-success') throw new Error(JSON.stringify(importedB));
        const currentXmp = xmp(importedB.profile.reference);
        const warmB = await pixels(await importing.send(exportRequest(currentXmp)));
        const baseline = await pixels(await importing.send(exportRequest(xmp(''))));
        importing.close(); // Destroy the only WASM registry that received imports.

        const cold = client();
        // First request, before status/initialization or any editor image open.
        const restored = await pixels(await cold.send(exportRequest(queued.xmp)));
        cold.close();
        await storedProfile(referenceA);
        const missingWorker = client();
        const missing = await missingWorker.send(exportRequest(queued.xmp));
        missingWorker.close();

        const disabledWorker = client();
        const disabled = await pixels(
          await disabledWorker.send(exportRequest(xmp(referenceA, 'crs:LensProfileEnable="0"'))),
        );
        disabledWorker.close();
        const zeroWorker = client();
        const zero = await pixels(
          await zeroWorker.send(
            exportRequest(
              xmp(
                referenceA,
                'crs:LensProfileDistortionScale="0" crs:LensProfileChromaticAberrationScale="0" crs:LensProfileVignettingScale="0"',
              ),
            ),
          ),
        );
        zeroWorker.close();

        await storedProfile(referenceA, profileB); // Wrong bytes under A's key must not be accepted.
        const corruptWorker = client();
        const corrupt = await corruptWorker.send(exportRequest(queued.xmp));
        corruptWorker.close();
        const maximumChange = Math.max(
          ...warmA.rgba.map((value, index) => Math.abs(value - baseline.rgba[index])),
        );
        return {
          referenceA,
          referenceB: importedB.profile.reference,
          resolution: importedA.profile.resolution,
          immutable: queued.xmp !== currentXmp && queued.xmp.includes(referenceA),
          warmA: warmA.digest,
          warmB: warmB.digest,
          baseline: baseline.digest,
          restored: restored.digest,
          disabled: disabled.digest,
          zero: zero.digest,
          dimensions: restored.dimensions,
          maximumChange,
          coldRequests: cold.sent,
          coldFetches: cold.fetched,
          missingFetches: missingWorker.fetched,
          disabledFetches: disabledWorker.fetched,
          zeroFetches: zeroWorker.fetched,
          missing,
          corrupt,
        };
      } finally {
        workerClients.forEach((worker) => worker.close());
      }
    },
    {
      workerPath: `/${workers[0]}`,
      profileA: lensExportProfile(-1.2),
      profileB: lensExportProfile(0.3),
    },
  );
  assert.deepEqual(errors, []);
  assert.equal(result.resolution.source, 'lcp');
  assert.equal(result.resolution.confidence, 'in-range');
  assert.equal(result.immutable, true);
  assert.notEqual(result.referenceA, result.referenceB);
  assert.deepEqual(result.coldRequests, ['export']);
  assert.deepEqual(result.dimensions, [64, 64]);
  assert.equal(result.restored, result.warmA, 'Cold queued export must restore A from IndexedDB');
  assert.notEqual(
    result.restored,
    result.warmB,
    'Later editor selection B must not replace queued A',
  );
  assert.ok(
    result.maximumChange > 2,
    `The calibration must visibly affect actual exported pixels (max ${result.maximumChange})`,
  );
  assert.notEqual(result.restored, result.baseline);
  assert.equal(result.missing.type, 'export-error');
  assert.match(result.missing.message, /local cache/);
  assert.equal(result.corrupt.type, 'export-error');
  assert.match(result.corrupt.message, /local cache/);
  assert.deepEqual(result.coldFetches, []);
  assert.deepEqual(result.missingFetches, [result.referenceA]);
  assert.deepEqual(result.disabledFetches, []);
  assert.deepEqual(result.zeroFetches, []);
  assert.equal(result.disabled, result.baseline);
  assert.equal(result.zero, result.baseline);
  assert.equal(
    hash(readFileSync(fixture)),
    originalHash,
    'Original RAW bytes must remain unchanged',
  );
  console.log(JSON.stringify({ passed: true, originalHash, ...result }, null, 2));
} finally {
  await browser.close();
  await server.stop();
}
