/**
 * Google access-token recovery (#5038): concurrent transfers share one
 * refresh instead of failing, a token Drive rejects is dropped and replaced,
 * and a refresh held by another process is waited out rather than recorded as
 * a connection failure. Real SQLite connection rows; only Google's HTTP
 * endpoints are stubbed.
 */
import { expect, test } from 'bun:test';
import { createLiveTestDatabase, insertFolder } from '../../db/sqlite/test-sqlite.test-helpers.ts';
import { sqliteDb } from '../../db/repos/db-handle.ts';
import { GOOGLE_BACKUP_DDL, loadConnection, saveConfig } from './repo.ts';
import { forgetGoogleAccessToken, googleAccessToken, type GoogleFetch } from './oauth.ts';
import { DEFAULT_GOOGLE_CONFIG, DRIVE_SCOPE } from './config.ts';
import { DriveClient } from './client.ts';

const clientId = '12345-example.apps.googleusercontent.com';

async function connectedDestination() {
  const db = await createLiveTestDatabase();
  if (!db.db.query("SELECT 1 FROM sqlite_master WHERE name='backup_google_connections'").get())
    db.db.exec(GOOGLE_BACKUP_DDL);
  const id = crypto.randomUUID();
  db.db
    .query(
      `INSERT INTO backup_destinations(id,library_id,kind,name,created_at)
       VALUES(?,?,'google-drive','Token recovery test',?)`,
    )
    .run(id, insertFolder(db.db), new Date().toISOString());
  await saveConfig(
    id,
    {
      ...DEFAULT_GOOGLE_CONFIG,
      clientMode: 'own',
      clientId,
      clientSecret: 'local-secret',
      refreshToken: 'saved-refresh',
      accountId: 'account-1',
    },
    0,
  );
  return { db, id };
}

/** Google's token, tokeninfo and about endpoints; each refresh mints a new
 * long-lived token (`access-1`, `access-2`, ...). */
function google(options: { holdToken?: Promise<void> } = {}) {
  let minted = 0;
  const tokenRequests: number[] = [];
  const transport: GoogleFetch = async (url) => {
    const href = url.toString();
    if (href.endsWith('/tokeninfo')) return Response.json({ aud: clientId, scope: DRIVE_SCOPE });
    if (href.includes('/about?'))
      return Response.json({ user: { permissionId: 'account-1', emailAddress: 'a@example.com' } });
    if (href.endsWith('/token')) {
      tokenRequests.push(Date.now());
      await options.holdToken;
      minted += 1;
      return Response.json({
        access_token: `access-${minted}`,
        token_type: 'Bearer',
        expires_in: 3600,
      });
    }
    throw new Error(`Unexpected network request: ${href}`);
  };
  return { transport, tokenRequests };
}

test('concurrent transfers share one in-flight refresh instead of failing', async () => {
  const { db, id } = await connectedDestination();
  using _db = db;
  let release!: () => void;
  const hold = new Promise<void>((resolve) => (release = resolve));
  const mock = google({ holdToken: hold });

  const callers = Array.from({ length: 5 }, () => googleAccessToken(id, mock.transport));
  await new Promise((resolve) => setTimeout(resolve, 50));
  release();

  expect(await Promise.all(callers)).toEqual(Array(5).fill('access-1'));
  expect(mock.tokenRequests).toHaveLength(1);
});

test('a forgotten token is replaced by a fresh one on the next request', async () => {
  const { db, id } = await connectedDestination();
  using _db = db;
  const mock = google();
  expect(await googleAccessToken(id, mock.transport)).toBe('access-1');
  expect(await googleAccessToken(id, mock.transport)).toBe('access-1');

  forgetGoogleAccessToken(id);

  expect(await googleAccessToken(id, mock.transport)).toBe('access-2');
  expect(mock.tokenRequests).toHaveLength(2);
});

test('a refresh held by another process is waited out, not failed', async () => {
  const { db, id } = await connectedDestination();
  using _db = db;
  const { epoch } = await loadConnection(id);
  await sqliteDb().write(
    `UPDATE backup_google_connections SET refresh_owner='other-process', refresh_until=?
     WHERE destination_id=? AND epoch=?`,
    [Date.now() + 60_000, id, epoch],
  );
  const mock = google();

  const pending = googleAccessToken(id, mock.transport);
  await new Promise((resolve) => setTimeout(resolve, 300));
  await sqliteDb().write(
    `UPDATE backup_google_connections SET refresh_owner=NULL, refresh_until=0 WHERE destination_id=?`,
    [id],
  );

  expect(await pending).toBe('access-1');
});

test('Drive rejecting a token drops it and retries once with a fresh one', async () => {
  const tokens = ['stale', 'fresh'];
  let forgotten = 0;
  const seen: string[] = [];
  const client = new DriveClient(
    async () => tokens[forgotten] ?? 'fresh',
    async (_url, init) => {
      const auth = new Headers(init?.headers).get('Authorization') ?? '';
      seen.push(auth);
      return auth === 'Bearer stale'
        ? new Response('unauthorized', { status: 401 })
        : Response.json({ id: 'file-1' });
    },
    () => {
      forgotten += 1;
    },
  );

  const response = await client.request('https://www.googleapis.com/drive/v3/files/file-1');

  expect(response.status).toBe(200);
  expect(seen).toEqual(['Bearer stale', 'Bearer fresh']);
  expect(forgotten).toBe(1);
});
