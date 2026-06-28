import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { MongoClient, ObjectId, type Db } from 'mongodb';
import { signAccessToken } from '../src/auth/tokens.ts';
import { listDirContents } from '../src/fs/browse.ts';

// JWT bootstrap MUST run before any module that touches `requireAuth`.
process.env.MAPLE_JWT_SECRET = 'x'.repeat(32);
const BEARER =
  'Bearer ' +
  (await signAccessToken(
    { sub: '00000000000000000000000a', email: 'tester@maple.local', role: 'owner' },
    process.env.MAPLE_JWT_SECRET!,
  ));

const TEST_DB = `maple_test_file_sync_${process.pid}`;
const PRIOR_MONGO_DB = process.env.MAPLE_MONGO_DB;
const PRIOR_MAPLE_ROOTS = process.env.MAPLE_ROOTS;
const MONGO_URI = process.env.MAPLE_MONGO_URI ?? 'mongodb://localhost:27017';

let mongo: MongoClient | null = null;
let mongoReachable = false;
let db: Db | null = null;
let realTmpRoot: string;
let folderId: ObjectId;

async function tryConnect(): Promise<MongoClient | null> {
  const c = new MongoClient(MONGO_URI, { serverSelectionTimeoutMS: 1500, connectTimeoutMS: 1500 });
  try {
    await c.connect();
    await c.db('admin').command({ ping: 1 });
    return c;
  } catch {
    try {
      await c.close();
    } catch {}
    return null;
  }
}

describe('FileProvider: sync all file types', () => {
  beforeAll(async () => {
    const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'maple-file-sync-'));
    realTmpRoot = await fs.realpath(tmpRoot);
    process.env.MAPLE_ROOTS = realTmpRoot;

    // A mix of non-image regular files, an extensionless file, and a subdir.
    // No image files — keeps `listDirContents` off the Mongo asset-link path
    // (and off the browse-index enqueue), so the unit test below is hermetic.
    await fs.writeFile(path.join(realTmpRoot, 'notes.txt'), 'hello');
    await fs.writeFile(path.join(realTmpRoot, 'clip.mov'), 'fakevideo');
    await fs.writeFile(path.join(realTmpRoot, 'README'), 'readme-bytes');
    await fs.mkdir(path.join(realTmpRoot, 'sub'));

    const { closeDb } = await import('../src/db/client.ts');
    await closeDb();
    process.env.MAPLE_MONGO_DB = TEST_DB;
    mongo = await tryConnect();
    mongoReachable = mongo !== null;
    if (!mongoReachable) return;
    db = mongo!.db(TEST_DB);
    await db.dropDatabase();
    folderId = new ObjectId();
    await db.collection('folders').insertOne({
      _id: folderId,
      path: realTmpRoot,
      label: 'test',
      created_at: new Date().toISOString(),
      file_count: 0,
    } as never);
  });

  afterAll(async () => {
    const { closeDb } = await import('../src/db/client.ts');
    await closeDb();
    if (mongo) await mongo.close();
    if (PRIOR_MONGO_DB === undefined) delete process.env.MAPLE_MONGO_DB;
    else process.env.MAPLE_MONGO_DB = PRIOR_MONGO_DB;
    if (PRIOR_MAPLE_ROOTS === undefined) delete process.env.MAPLE_ROOTS;
    else process.env.MAPLE_ROOTS = PRIOR_MAPLE_ROOTS;
    if (realTmpRoot) await fs.rm(realTmpRoot, { recursive: true, force: true }).catch(() => {});
  });

  // listDirContents is exercised directly (no route, no Mongo) since there
  // are no still images in the fixture.
  test('listDirContents surfaces video files in `images` and other non-image files in `files`', async () => {
    const res = await listDirContents(realTmpRoot);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const { data } = res;

    expect(data.sidecars).toHaveLength(0);
    expect(data.dirs.map((d) => d.name)).toContain('sub');

    // clip.mov is a video — surfaces in images with isVideo=true.
    const videoEntry = data.images.find((i) => i.name === 'clip.mov');
    expect(videoEntry).toBeDefined();
    expect(videoEntry?.isVideo).toBe(true);
    expect(videoEntry?.ext).toBe('mov');

    // Non-video, non-image files land in files.
    const byName = new Map(data.files.map((f) => [f.name, f]));
    expect([...byName.keys()].sort()).toEqual(['README', 'notes.txt']);
    expect(byName.get('notes.txt')!.ext).toBe('txt');
    expect(byName.get('README')!.ext).toBe('');
    for (const f of data.files) {
      expect(typeof f.path).toBe('string');
      expect(f.path.startsWith(realTmpRoot)).toBe(true);
      expect(typeof f.size).toBe('number');
      expect(f.size).toBeGreaterThan(0);
      expect(typeof f.mtime).toBe('string');
    }
  });

  test('GET /:id/file streams the raw bytes of a non-indexed file', async () => {
    if (!mongoReachable) return;
    const { app } = await import('../src/index.ts');
    const res = await app.handle(
      new Request(
        `http://localhost/api/folders/${folderId.toHexString()}/file?path=${encodeURIComponent('notes.txt')}`,
        { headers: { Authorization: BEARER } },
      ),
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('hello');
  });

  test('GET /:id/file-meta returns stat without bytes', async () => {
    if (!mongoReachable) return;
    const { app } = await import('../src/index.ts');
    const res = await app.handle(
      new Request(
        `http://localhost/api/folders/${folderId.toHexString()}/file-meta?path=${encodeURIComponent('clip.mov')}`,
        { headers: { Authorization: BEARER } },
      ),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { name: string; size: number; ext: string; mtime: string };
    expect(body.name).toBe('clip.mov');
    expect(body.ext).toBe('mov');
    expect(body.size).toBe('fakevideo'.length);
    expect(typeof body.mtime).toBe('string');
  });

  test('GET /:id/file rejects a path-escape attempt', async () => {
    if (!mongoReachable) return;
    const { app } = await import('../src/index.ts');
    const res = await app.handle(
      new Request(
        `http://localhost/api/folders/${folderId.toHexString()}/file?path=${encodeURIComponent('../../etc/passwd')}`,
        { headers: { Authorization: BEARER } },
      ),
    );
    expect(res.status).toBe(400);
  });

  test('GET /:id/file 404s for a missing file', async () => {
    if (!mongoReachable) return;
    const { app } = await import('../src/index.ts');
    const res = await app.handle(
      new Request(
        `http://localhost/api/folders/${folderId.toHexString()}/file?path=${encodeURIComponent('nope.bin')}`,
        { headers: { Authorization: BEARER } },
      ),
    );
    expect(res.status).toBe(404);
  });
});
