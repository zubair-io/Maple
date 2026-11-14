/**
 * `GET /api/service/photos/:assetId/{thumb,preview}`: served through the app's own thumbnail and
 * preview routes from a real temporary library, with warm cache files so no decoder is needed.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, realpath, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { resolveThumbPath } from '../src/fs/xmp.ts';
import { invalidateLibraryRoots } from '../src/indexer/libraries.cache.ts';
import { PREVIEW_CACHE_SUFFIX } from '../src/indexer/previewer.ts';
import {
  createServiceFixture,
  serviceRequest,
  type ServiceFixture,
} from './helpers/service-photos-fixtures.ts';

let root: string;
let fx: ServiceFixture;

const THUMB = Buffer.from([1, 2, 3, 4]);
const PREVIEW = Buffer.from([5, 6, 7, 8, 9]);

async function warmPhoto(filename: string, owner?: string): Promise<string> {
  const source = join(root, 'trip', filename);
  await mkdir(dirname(source), { recursive: true });
  await writeFile(source, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
  const past = new Date(Date.now() - 60_000);
  await utimes(source, past, past);
  const thumb = resolveThumbPath(source);
  const preview = join(root, 'trip', '.maple', 'previews', `${filename}.${PREVIEW_CACHE_SUFFIX}`);
  for (const [path, bytes] of [
    [thumb, THUMB],
    [preview, PREVIEW],
  ] as const) {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, bytes);
  }
  return fx.photo({ filename, path: 'trip', capturedAt: '2024-07-04T10:00:00.000Z' }, owner);
}

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'maple-service-photos-')));
  fx = await createServiceFixture({ libraryRoot: root });
  invalidateLibraryRoots();
});

afterEach(async () => {
  fx.close();
  invalidateLibraryRoots();
  await rm(root, { recursive: true, force: true });
});

describe('photo derivatives', () => {
  it('serves the cached thumbnail and preview as private AVIF', async () => {
    const id = await warmPhoto('beach day.jpg');

    for (const [kind, bytes] of [
      ['thumb', THUMB],
      ['preview', PREVIEW],
    ] as const) {
      const response = await serviceRequest(`/photos/${id}/${kind}`, fx.key);
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toBe('image/avif');
      expect(response.headers.get('cache-control')).toStartWith('private');
      expect(response.headers.get('x-maple-cacheable')).toBeNull();
      expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes);

      const etag = response.headers.get('etag');
      expect(etag).toBeString();
      const revalidated = await serviceRequest(`/photos/${id}/${kind}`, fx.key, {
        headers: { 'if-none-match': etag! },
      });
      expect(revalidated.status).toBe(304);
      expect(revalidated.headers.get('cache-control')).toStartWith('private');
    }
  });

  it('404s another user’s photo before touching its files', async () => {
    const theirs = await warmPhoto('theirs.jpg', fx.otherId);
    for (const kind of ['thumb', 'preview']) {
      const response = await serviceRequest(`/photos/${theirs}/${kind}`, fx.key);
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: 'not_found', message: 'No such photo.' });
    }
  });

  it('answers in the service error shape when the image cannot be produced', async () => {
    const id = fx.photo({
      filename: 'gone.jpg',
      path: 'trip',
      capturedAt: '2024-07-04T10:00:00.000Z',
    });
    const response = await serviceRequest(`/photos/${id}/thumb`, fx.key);
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(await response.json()).toEqual({
      error: expect.any(String),
      message: expect.any(String),
    });
  });
});
