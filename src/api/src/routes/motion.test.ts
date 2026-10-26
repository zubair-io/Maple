import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Elysia } from 'elysia';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from '../fs/mirrored.ts';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { signAccessToken } from '../auth/tokens.ts';
import {
  createLiveTestDatabase,
  run,
  type LiveTestDatabase,
} from '../db/sqlite/test-sqlite.test-helpers.ts';
import { containerXmp, jpeg, mp4 } from '../indexer/motion-photo/motion-photo.fixtures.ts';
import { requestContext } from '../middleware/request-context.ts';
import { securityHeaders } from '../middleware/security-headers.ts';
import { registerLibrary, seedRouteAsset } from '../../tests/helpers/assets-route-fixtures.ts';
import { motionRoutes } from './motion.ts';

const SECRET = 'motion-route-test-secret-at-least-16';
const ADDRESS = '/api/motion/motion-test/phone/PXL_1.MP.jpg';

describe('/api/motion/:slug/*', () => {
  let live: LiveTestDatabase;
  let dir = '';
  let original = '';
  let originalBytes: Buffer = Buffer.alloc(0);
  let clip: Buffer = Buffer.alloc(0);
  let assetId = '';
  let token = '';
  const originalSecret = process.env.MAPLE_JWT_SECRET;

  beforeEach(async () => {
    live = await createLiveTestDatabase();
    dir = await realpath(await mkdtemp(join(tmpdir(), 'maple-motion-route-')));
    await mkdir(join(dir, 'phone'));
    clip = mp4('motion-route-clip-payload');
    const xmp = containerXmp({ MotionPhoto: '1', MotionPhotoVersion: '1' }, [
      { mime: 'image/jpeg', semantic: 'Primary', length: 0, padding: 0 },
      {
        mime: 'video/mp4',
        semantic: 'MotionPhoto',
        length: clip.length,
        padding: 0,
      },
    ]);
    originalBytes = Buffer.concat([jpeg(xmp), clip]);
    original = join(dir, 'phone', 'PXL_1.MP.jpg');
    await writeFile(original, originalBytes);
    const libraryId = registerLibrary(live.db, dir, 'motion-test');
    assetId = seedRouteAsset(live.db, {
      libraryId,
      path: 'phone',
      filename: 'PXL_1.MP.jpg',
      size: originalBytes.length,
    });
    recordClip(originalBytes.length - clip.length, clip.length, originalBytes.length);
    process.env.MAPLE_JWT_SECRET = SECRET;
    token = await signAccessToken(
      {
        sub: 'u1',
        email: 'user@example.com',
        role: 'member',
        file_access: false,
      },
      SECRET,
    );
  });

  afterEach(async () => {
    live.close();
    await rm(dir, { recursive: true, force: true });
    if (originalSecret === undefined) delete process.env.MAPLE_JWT_SECRET;
    else process.env.MAPLE_JWT_SECRET = originalSecret;
  });

  function recordClip(start: number | null, length: number | null, sourceSize: number | null) {
    run(
      live.db,
      `UPDATE assets SET motion_video_start = ?, motion_video_length = ?,
              motion_video_mime = ?, motion_source_size = ? WHERE id = ?`,
      start,
      length,
      length === null ? null : 'video/mp4',
      sourceSize,
      assetId,
    );
  }

  function request(
    options: {
      range?: string;
      method?: string;
      token?: string;
      address?: string;
    } = {},
  ): Promise<Response> {
    const query = options.token === '' ? '' : `?token=${options.token ?? token}`;
    return new Elysia()
      .use(requestContext)
      .use(securityHeaders)
      .use(motionRoutes)
      .handle(
        new Request(`http://localhost${options.address ?? ADDRESS}${query}`, {
          method: options.method ?? 'GET',
          headers: options.range ? { Range: options.range } : undefined,
        }),
      );
  }

  test('rejects a missing token', async () => {
    expect((await request({ token: '' })).status).toBe(401);
  });

  test('serves the whole clip, and only the clip', async () => {
    const response = await request();
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('video/mp4');
    expect(response.headers.get('Accept-Ranges')).toBe('bytes');
    expect(response.headers.get('Content-Length')).toBe(String(clip.length));
    expect(Buffer.from(await response.arrayBuffer()).equals(clip)).toBe(true);
  });

  test('serves a byte range relative to the clip through the real middleware', async () => {
    const response = await request({ range: 'bytes=4-11' });
    expect(response.status).toBe(206);
    expect(response.headers.get('Content-Range')).toBe(`bytes 4-11/${clip.length}`);
    const body = Buffer.from(await response.arrayBuffer());
    expect(body.equals(clip.subarray(4, 12))).toBe(true);
  });

  test('serves a suffix range from the end of the clip, not the end of the file', async () => {
    const response = await request({ range: 'bytes=-6' });
    expect(response.status).toBe(206);
    expect(Buffer.from(await response.arrayBuffer()).equals(clip.subarray(clip.length - 6))).toBe(
      true,
    );
  });

  test('refuses a range past the end of the clip', async () => {
    const response = await request({ range: `bytes=${clip.length}-` });
    expect(response.status).toBe(416);
    expect(response.headers.get('Content-Range')).toBe(`bytes */${clip.length}`);
  });

  test('HEAD reports a playable clip without a body', async () => {
    const response = await request({ method: 'HEAD' });
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Length')).toBe(String(clip.length));
  });

  test('404s a still with no recorded clip', async () => {
    recordClip(null, null, null);
    expect((await request()).status).toBe(404);
    expect((await request({ method: 'HEAD' })).status).toBe(404);
  });

  test('404s an unknown address', async () => {
    expect((await request({ address: '/api/motion/motion-test/phone/other.jpg' })).status).toBe(
      404,
    );
  });

  test('refuses a recorded range once the original changed size', async () => {
    await writeFile(original, Buffer.concat([originalBytes, Buffer.from('appended')]));
    expect((await request()).status).toBe(404);
  });

  test('refuses a recorded range that no longer opens with ftyp', async () => {
    const overwritten = Buffer.from(originalBytes);
    overwritten.fill(0x41, originalBytes.length - clip.length);
    await writeFile(original, overwritten);
    expect((await request()).status).toBe(404);
  });

  test('never modifies the original', async () => {
    await request({ range: 'bytes=0-3' });
    expect((await readFile(original)).equals(originalBytes)).toBe(true);
  });
});
