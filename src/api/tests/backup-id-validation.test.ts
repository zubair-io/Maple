import { test, expect } from 'bun:test';
import { Elysia } from 'elysia';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { MongoClient, ObjectId } from 'mongodb';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { backupIngestRoutes } from '../src/routes/backup-ingest.ts';
import { backupRenderedRoutes } from '../src/routes/backup-rendered.ts';
import { backupExistsRoutes } from '../src/routes/backup-exists.ts';
import { backupSidecarRoutes } from '../src/routes/backup-sidecar.ts';
import { closeDb } from '../src/db/client.ts';

test('invalid IDs never advance uploads; normalized IDs preserve resume, retry and dedup', async () => {
  const server = await MongoMemoryServer.create();
  const client = new MongoClient(server.getUri());
  const previous = { uri: process.env.MAPLE_MONGO_URI, db: process.env.MAPLE_MONGO_DB };
  process.env.MAPLE_MONGO_URI = server.getUri();
  process.env.MAPLE_MONGO_DB = 'backup_id_validation';
  const root = await mkdtemp(join(tmpdir(), 'maple-id-upload-'));
  try {
    await closeDb();
    await client.connect();
    const db = client.db('backup_id_validation');
    const libraryId = new ObjectId();
    await db.collection('folders').insertOne({ _id: libraryId, path: root });
    const app = new Elysia()
      .use(backupIngestRoutes)
      .use(backupRenderedRoutes)
      .use(backupExistsRoutes)
      .use(backupSidecarRoutes);
    const id = '01' + 'ab'.repeat(15);
    const send = (
      route: string,
      mapleId: string | undefined,
      range = 'bytes 0-3/4',
      phid = 'test-photo',
    ) =>
      app.handle(
        new Request(`http://localhost/api/libraries/${libraryId}/backup/${route}`, {
          method: 'POST',
          body: new Uint8Array([1, 2]),
          headers: {
            'content-type': 'application/octet-stream',
            'x-maple-device-id': 'id-contract',
            'x-maple-phasset-id': phid,
            'x-maple-capture-date': '2024-03-15T10:30:00Z',
            'x-maple-filename': 'photo.HEIC',
            'x-maple-target-rel-path': '2024/Misc/photo.HEIC',
            'x-maple-total-bytes': '4',
            'content-range': range,
            ...(mapleId === undefined
              ? {}
              : { 'x-maple-maple-id': mapleId, 'x-maple-id': mapleId }),
          },
        }),
      );
    for (const route of ['ingest', 'rendered', 'sidecar']) {
      expect((await send(route, '01' + '0g'.repeat(15))).status).toBe(400);
      expect(await db.collection('upload_sessions').countDocuments()).toBe(0);
      expect(await db.collection('assets').countDocuments()).toBe(0);
    }
    expect((await send('ingest', undefined, 'bytes 0-1/4')).status).toBe(202);
    const session = await db.collection('upload_sessions').findOne({});
    expect(session?.received_bytes).toBe(2);
    for (const value of [undefined, '01' + 'f!'.repeat(15)]) {
      expect((await send('ingest', value, 'bytes 2-3/4')).status).toBe(400);
      expect((await db.collection('upload_sessions').findOne({}))?.received_bytes).toBe(2);
    }
    const finished = await send('ingest', id.toUpperCase(), 'bytes 2-3/4');
    expect(finished.status).toBe(200);
    const result = await finished.json();
    expect(result.maple_id).toBe(id);
    expect((await db.collection('assets').findOne({}))?.maple_id).toBe(id);
    expect((await db.collection('upload_sessions').findOne({}))?.maple_id).toBe(id);
    expect(await readFile(join(root, result.target_rel_path))).toEqual(Buffer.from([1, 2, 1, 2]));
    expect((await send('ingest', id.toUpperCase(), 'bytes 2-3/4')).status).toBe(200);
    expect((await send('ingest', undefined, 'bytes 0-1/4', 'duplicate-photo')).status).toBe(202);
    expect((await send('ingest', id.toUpperCase(), 'bytes 2-3/4', 'duplicate-photo')).status).toBe(
      200,
    );
    expect(await db.collection('assets').countDocuments()).toBe(1);
    for (const ids of [[id.toUpperCase()], ['bad']]) {
      const response = await app.handle(
        new Request(`http://localhost/api/libraries/${libraryId}/backup/exists`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ maple_ids: ids }),
        }),
      );
      expect(response.status).toBe(ids[0] === 'bad' ? 400 : 200);
      await assertMissingIds(response);
    }
  } finally {
    await closeDb();
    await client.close();
    await server.stop();
    await rm(root, { recursive: true });
    restoreMongoEnvironment(previous);
  }
}, 30000);

function restoreMongoEnvironment(previous: { uri: string | undefined; db: string | undefined }) {
  if (previous.uri === undefined) delete process.env.MAPLE_MONGO_URI;
  else process.env.MAPLE_MONGO_URI = previous.uri;
  if (previous.db === undefined) delete process.env.MAPLE_MONGO_DB;
  else process.env.MAPLE_MONGO_DB = previous.db;
}

async function assertMissingIds(response: Response) {
  if (response.status === 200) expect(await response.json()).toEqual({ missing: [] });
}
