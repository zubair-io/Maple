/** Expected stale variant edits return a reloadable conflict across every mutation. */
import { expect, spyOn, test } from 'bun:test';
import { Elysia } from 'elysia';
import * as path from 'node:path';
import { recoveryFixture } from '../cloud-backup/restore.test-helpers';
import { insertAsset, insertLocation, insertFolder } from '../db/sqlite/test-sqlite.test-helpers';
import { readFile, rename, writeFile } from '../fs/mirrored';
import { serializeSidecarWrite } from '../fs/sidecar-write-order';
import * as binding from './xmp-change';
import { xmpPathRoutes } from './xmp';
import { xmpRoutes } from './assets/xmp';

const corpus = JSON.parse(
  await readFile(
    new URL('../../../../test-fixtures/workflow/contract-v1.json', import.meta.url),
    'utf8',
  ),
);
const xml = corpus[0].history[0].adjustmentXmp as string;
const app = new Elysia().use(xmpPathRoutes).group('/api/assets', (router) => router.use(xmpRoutes));

const mutations: Record<
  string,
  { route: string; method: string; body?: unknown; conflict?: boolean; conditional?: boolean }
> = {
  path: { route: '', method: 'POST', body: xml },
  conditional: { route: '', method: 'POST', body: xml, conditional: true },
  delete: { route: '', method: 'DELETE' },
  workflow: { route: '/workflow', method: 'PATCH', body: { ...corpus[0], variantId: 'primary' } },
  save: { route: '/variant', method: 'PUT', body: xml },
  commit: {
    route: '/variant/commit',
    method: 'POST',
    body: { expectedXmp: xml, xmp: xml, entry: corpus[0].history[0] },
  },
  snapshot: {
    route: '/variant/snapshot',
    method: 'POST',
    body: {
      expectedXmp: xml,
      snapshot: { id: crypto.randomUUID(), name: 'Checkpoint', createdAtMs: 1, adjustmentXmp: xml },
    },
  },
  restore: {
    route: '/variant/restore',
    method: 'POST',
    body: { expectedXmp: xml, xmp: xml, entry: corpus[0].history[0] },
  },
  'asset-put': { route: 'asset', method: 'PUT', body: xml },
  'asset-delete': { route: 'asset', method: 'DELETE' },
  'conflict-put': { route: 'asset', method: 'PUT', body: xml, conflict: true },
  'conflict-delete': { route: 'asset', method: 'DELETE', conflict: true },
};

function mutationRequest(operation: string, photo: string, assetId: string): Request {
  const mutation = mutations[operation];
  const url =
    mutation.route === 'asset'
      ? `http://localhost/api/assets/${assetId}/xmp${mutation.conflict ? '?conflict=photo%20(conflict%20from%20Device)' : ''}`
      : `http://localhost/api/xmp${mutation.route}?path=${encodeURIComponent(photo)}&variantId=primary`;
  const xmlBody = typeof mutation.body === 'string';
  return new Request(url, {
    method: mutation.method,
    headers: {
      'Content-Type': xmlBody ? 'application/xml' : 'application/json',
      ...(mutation.conditional ? { 'If-None-Match': '*' } : {}),
    },
    body: xmlBody ? (mutation.body as string) : JSON.stringify(mutation.body),
  });
}

for (const operation of Object.keys(mutations)) {
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
      const libraryId = insertFolder(f.live.db, { path: f.root });
      const assetId = insertAsset(f.live.db);
      insertLocation(f.live.db, { assetId, libraryId, path: '', filename: 'photo.dng' });
      await writeFile(photo, 'original');
      await writeFile(sidecar, xml);
      holder = serializeSidecarWrite(sidecar, async () => {
        held.resolve();
        await release.promise;
      });
      await held.promise;
      request = app.handle(mutationRequest(operation, photo, assetId));
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
