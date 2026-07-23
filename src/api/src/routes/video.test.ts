import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Elysia } from 'elysia';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { signAccessToken } from '../auth/tokens.ts';
import { videoRoutes } from './video.ts';

const SECRET = 'video-route-test-secret-at-least-16';

describe('GET /api/video/fs', () => {
  let dir = '';
  let file = '';
  let token = '';
  const originalSecret = process.env.MAPLE_JWT_SECRET;
  const originalRoots = process.env.MAPLE_ROOTS;

  beforeEach(async () => {
    dir = await realpath(await mkdtemp(join(tmpdir(), 'maple-video-route-')));
    file = join(dir, 'clip.mp4');
    await writeFile(file, Buffer.from('0123456789'));
    process.env.MAPLE_ROOTS = dir;
    process.env.MAPLE_JWT_SECRET = SECRET;
    token = await signAccessToken({ sub: 'u1', email: 'user@example.com', role: 'member' }, SECRET);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
    if (originalSecret === undefined) delete process.env.MAPLE_JWT_SECRET;
    else process.env.MAPLE_JWT_SECRET = originalSecret;
    if (originalRoots === undefined) delete process.env.MAPLE_ROOTS;
    else process.env.MAPLE_ROOTS = originalRoots;
  });

  function request(range?: string, suppliedToken = token): Promise<Response> {
    const query = new URLSearchParams({ path: file });
    if (suppliedToken) query.set('token', suppliedToken);
    return new Elysia().use(videoRoutes).handle(
      new Request(`http://localhost/api/video/fs?${query}`, {
        headers: range ? { Range: range } : undefined,
      }),
    );
  }

  test('rejects a missing token', async () => {
    expect((await request(undefined, '')).status).toBe(401);
  });

  test('serves the complete file without Range', async () => {
    const response = await request();
    expect(response.status).toBe(200);
    expect(response.headers.get('Accept-Ranges')).toBe('bytes');
    expect(response.headers.get('Content-Type')).toBe('video/mp4');
    expect(await response.text()).toBe('0123456789');
  });

  test('serves exactly the requested bytes', async () => {
    const response = await request('bytes=2-5');
    expect(response.status).toBe(206);
    expect(response.headers.get('Content-Range')).toBe('bytes 2-5/10');
    expect(response.headers.get('Content-Length')).toBe('4');
    expect(await response.text()).toBe('2345');
  });

  test('returns 416 for an unsatisfiable range', async () => {
    const response = await request('bytes=10-');
    expect(response.status).toBe(416);
    expect(response.headers.get('Content-Range')).toBe('bytes */10');
  });
});
