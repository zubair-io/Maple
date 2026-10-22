/** Expected stale variant edits return a reloadable conflict across every mutation. */
import { expect, spyOn, test } from 'bun:test';
import { Elysia } from 'elysia';
import * as path from 'node:path';
import { recoveryFixture } from '../cloud-backup/restore.test-helpers';
import { insertFolder } from '../db/sqlite/test-sqlite.test-helpers';
import { readFile, rename, writeFile } from '../fs/mirrored';
import { serializeSidecarWrite } from '../fs/sidecar-write-order';
import * as binding from './xmp-change';
import { xmpPathRoutes } from './xmp';

const corpus = JSON.parse(
  await readFile(
    new URL('../../../../test-fixtures/workflow/contract-v1.json', import.meta.url),
    'utf8',
  ),
);
const xml = corpus[0].history[0].adjustmentXmp as string;
const app = new Elysia().use(xmpPathRoutes);

for (const operation of ['save', 'commit', 'snapshot', 'restore'] as const) {
  test(`a stale ${operation} returns HTTP 409 with reload guidance`, async () => {
    const f = await recoveryFixture();
    const photo = path.join(f.root, 'photo.dng');
    const sidecar = path.join(f.root, 'photo.xmp');
    const captured = Promise.withResolvers<void>();
    const held = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const capture = binding.captureSidecarWriteScope;
    const capturing = spyOn(binding, 'captureSidecarWriteScope').mockImplementation(
      async (...args) => {
        const scope = await capture(...args);
        captured.resolve();
        return scope;
      },
    );
    let holder: Promise<unknown> | undefined;
    let request: Promise<Response> | undefined;
    try {
      insertFolder(f.live.db, { path: f.root });
      await writeFile(photo, 'original');
      await writeFile(sidecar, xml);
      holder = serializeSidecarWrite(sidecar, async () => {
        held.resolve();
        await release.promise;
      });
      await held.promise;
      const body =
        operation === 'save'
          ? xml
          : operation === 'snapshot'
            ? {
                expectedXmp: xml,
                snapshot: {
                  id: crypto.randomUUID(),
                  name: 'Checkpoint',
                  createdAtMs: 1,
                  adjustmentXmp: xml,
                },
              }
            : { expectedXmp: xml, xmp: xml, entry: corpus[0].history[0] };
      request = app.handle(
        new Request(
          `http://localhost/api/xmp/variant${operation === 'save' ? '' : '/' + operation}?path=${encodeURIComponent(photo)}&variantId=primary`,
          {
            method: operation === 'save' ? 'PUT' : 'POST',
            headers: {
              'Content-Type': operation === 'save' ? 'application/xml' : 'application/json',
            },
            body: typeof body === 'string' ? body : JSON.stringify(body),
          },
        ),
      );
      await captured.promise;
      const incoming = path.join(f.root, 'incoming.dng');
      await writeFile(incoming, 'replacement');
      await rename(incoming, photo);
      release.resolve();
      const response = await request;
      expect(response.status).toBe(409);
      expect(await response.text()).toContain('reload before saving');
      expect(await readFile(sidecar, 'utf8')).toBe(xml);
    } finally {
      release.resolve();
      await Promise.allSettled([holder, request]);
      capturing.mockRestore();
      await f.close();
    }
  });
}
