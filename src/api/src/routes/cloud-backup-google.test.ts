import { expect, test } from 'bun:test';
import { Elysia } from 'elysia';
import { signAccessToken } from '../auth/tokens.ts';
import { createLiveTestDatabase, insertFolder } from '../db/sqlite/test-sqlite.test-helpers.ts';
import { buildGoogleBackupRoutes } from './cloud-backup-google.ts';
import { GOOGLE_BACKUP_DDL, saveConfig } from '../cloud-backup/google/repo.ts';
import { insertUser } from '../db/repos/auth.users.repo.ts';
import { DEFAULT_GOOGLE_CONFIG, DRIVE_SCOPE } from '../cloud-backup/google/config.ts';
import type { GoogleFetch } from '../cloud-backup/google/oauth.ts';
import { BackupRepository } from '../cloud-backup/repository.ts';

const destinationId = 'e9aa2f31-ccdd-4e77-9999-0619988bac3c';
const origin = 'https://photos.example.com';
const secret = 'google-route-test-secret-must-be-long';
function routes(transport?: GoogleFetch) {
  const { owner, callback } = buildGoogleBackupRoutes({
    origin: async () => origin,
    destination: (id) => new BackupRepository().destination(id),
    attachRoot: async (id, rootId, accountId, generation) => {
      const result = await new BackupRepository().db.write(
        'UPDATE backup_destinations SET root_id=?,account_id=? WHERE id=? AND generation=?',
        [rootId, accountId, id, generation],
      );
      if (result.changes !== 1) throw new Error('Destination changed');
    },
    connectionChanged: async (id) => {
      await new BackupRepository().db.write(
        'UPDATE backup_destinations SET generation=generation+1 WHERE id=?',
        [id],
      );
    },
    connectionRestored: async (id) =>
      new BackupRepository().clearResolvedGoogleConnectionErrors(id),
    transport,
  });
  return new Elysia().use(new Elysia({ name: 'isolatedGoogleOwner' }).use(owner)).use(callback);
}
function insertDestination(db: Parameters<typeof insertFolder>[0]) {
  db.query(
    `INSERT INTO backup_destinations(id,library_id,kind,name,created_at)
    VALUES(?,?,'google-drive','Google route test',?)`,
  ).run(destinationId, insertFolder(db), new Date().toISOString());
}
test('owner gate stays isolated from cookie/state guarded callback; member cannot configure credentials', async () => {
  const previous = process.env.MAPLE_JWT_SECRET;
  process.env.MAPLE_JWT_SECRET = secret;
  try {
    const app = routes();
    const member = await signAccessToken(
      {
        sub: '111111111111111111111111',
        email: null,
        role: 'member',
        file_access: false,
      },
      secret,
    );
    const response = await app.handle(
      new Request(`${origin}/api/cloud-backup/google/${destinationId}/config`, {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${member}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          clientId: 'id.apps.googleusercontent.com',
          clientSecret: 'secret',
          callbackMode: 'relay',
        }),
      }),
    );
    expect(response.status).toBe(403);
    const callback = await app.handle(
      new Request(
        `${origin}/api/cloud-backup/google/callback?code=private-code&state=private-state`,
      ),
    );
    expect(callback.status).toBe(303);
    const redirect = new URL(callback.headers.get('location')!);
    expect(redirect.origin).toBe(origin);
    expect(redirect.searchParams.get('googleError')).toBe('Invalid Google callback.');
    expect(redirect.searchParams.has('code')).toBe(false);
    expect(redirect.searchParams.has('state')).toBe(false);
    expect(callback.headers.get('set-cookie')).toContain('Max-Age=0');
    expect(callback.headers.get('cache-control')).toBe('no-store');
    expect(callback.headers.get('referrer-policy')).toBe('no-referrer');
  } finally {
    process.env.MAPLE_JWT_SECRET = previous;
  }
});

test('config rejects malformed Google Drive root IDs before calling Drive', async () => {
  using db = await createLiveTestDatabase();
  insertDestination(db.db);
  const previous = process.env.MAPLE_JWT_SECRET;
  process.env.MAPLE_JWT_SECRET = secret;
  try {
    const owner = await signAccessToken(
      {
        sub: '111111111111111111111111',
        email: null,
        role: 'owner',
        file_access: true,
      },
      secret,
    );
    const response = await routes().handle(
      new Request(`${origin}/api/cloud-backup/google/${destinationId}/config`, {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${owner}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ callbackMode: 'relay', rootId: 'invalid/root-id' }),
      }),
    );
    expect(response.status).toBe(422);
  } finally {
    process.env.MAPLE_JWT_SECRET = previous;
  }
});

for (const existingRoot of [undefined, 'existing-backup-root']) {
  test(`bound callback ${existingRoot ? 'attaches the existing root' : 'creates the backup root'} and preserves it on reconnect`, async () => {
    using db = await createLiveTestDatabase();
    insertDestination(db.db);
    if (!db.db.query("SELECT 1 FROM sqlite_master WHERE name='backup_google_connections'").get())
      db.db.exec(GOOGLE_BACKUP_DDL);
    const user = await insertUser({
      email: 'proxy-owner@example.com',
      role: 'owner',
      created_at: new Date().toISOString(),
      last_seen_at: null,
    });
    await saveConfig(
      destinationId,
      {
        ...DEFAULT_GOOGLE_CONFIG,
        clientMode: 'own',
        clientId: '12345-example.apps.googleusercontent.com',
        clientSecret: 'local-secret',
        callbackMode: 'direct',
      },
      0,
    );
    const previous = process.env.MAPLE_JWT_SECRET;
    process.env.MAPLE_JWT_SECRET = secret;
    try {
      const bearer = await signAccessToken(
        { sub: user.toHexString(), email: null, role: 'owner', file_access: true },
        secret,
      );
      let rootsCreated = 0;
      const app = routes(async (url, init) => {
        const request = new URL(url);
        if (request.pathname.endsWith('/files/existing-backup-root'))
          return Response.json({
            id: 'existing-backup-root',
            name: 'Recovered Maple backup',
            mimeType: 'application/vnd.google-apps.folder',
            ownedByMe: true,
            parents: ['root'],
            description: JSON.stringify({ mapleBackupRoot: 1, identity: 'recovered-library' }),
          });
        if (request.pathname.endsWith('/generateIds'))
          return Response.json({ ids: ['automatically-created-root'] });
        if (request.pathname.endsWith('/files/automatically-created-root'))
          return new Response(null, { status: 404 });
        if (request.pathname.endsWith('/files') && init?.method === 'POST') {
          rootsCreated++;
          const folder = JSON.parse(String(init.body));
          expect(folder.name).toBe('Maple Photo Backup');
          expect(folder.parents).toEqual(['root']);
          return Response.json({ id: folder.id });
        }
        if (url.toString().endsWith('/token'))
          return Response.json({
            access_token: 'token-local',
            refresh_token: 'refresh-local',
            token_type: 'Bearer',
            expires_in: 30,
          });
        if (url.toString().endsWith('/tokeninfo'))
          return Response.json({
            aud: '12345-example.apps.googleusercontent.com',
            scope: DRIVE_SCOPE,
          });
        return Response.json({ user: { permissionId: 'account-1' } });
      });
      const started = await app.handle(
        new Request(`http://127.0.0.1:3000/api/cloud-backup/google/${destinationId}/start`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${bearer}`,
            Origin: origin,
            'X-Forwarded-Host': 'evil.example',
            ...(existingRoot ? { 'Content-Type': 'application/json' } : {}),
          },
          ...(existingRoot ? { body: JSON.stringify({ rootId: existingRoot }) } : {}),
        }),
      );
      expect(started.status).toBe(200);
      const cookie = started.headers.get('set-cookie')!;
      expect(cookie).toContain('; Secure');
      const state = new URL((await started.json()).authorizationUrl).searchParams.get('state')!;
      const callback = await app.handle(
        new Request(
          `http://127.0.0.1:3000/api/cloud-backup/google/callback?code=code&state=${state}`,
          {
            headers: { Cookie: cookie.split(';')[0]!, 'X-Forwarded-Host': 'evil.example' },
          },
        ),
      );
      expect(callback.status).toBe(303);
      expect(callback.headers.get('location')).toBe(
        `${origin}/settings/backup?connected=${destinationId}`,
      );
      expect((await new BackupRepository().destination(destinationId))?.rootId).toBe(
        existingRoot ?? 'automatically-created-root',
      );
      expect(rootsCreated).toBe(existingRoot ? 0 : 1);
      const reconnected = await app.handle(
        new Request(`${origin}/api/cloud-backup/google/${destinationId}/start`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${bearer}`, Origin: origin },
        }),
      );
      const reconnectState = new URL((await reconnected.json()).authorizationUrl).searchParams.get(
        'state',
      )!;
      const reconnectCookie = reconnected.headers.get('set-cookie')!.split(';')[0]!;
      const completed = await app.handle(
        new Request(
          `${origin}/api/cloud-backup/google/callback?code=code&state=${reconnectState}`,
          {
            headers: { Cookie: reconnectCookie },
          },
        ),
      );
      expect(completed.headers.get('location')).toBe(
        `${origin}/settings/backup?connected=${destinationId}`,
      );
      expect(rootsCreated).toBe(existingRoot ? 0 : 1);
      const wrongOrigin = await app.handle(
        new Request(`http://127.0.0.1:3000/api/cloud-backup/google/${destinationId}/start`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${bearer}`, Origin: 'https://evil.example' },
        }),
      );
      expect(wrongOrigin.status).toBe(400);
    } finally {
      process.env.MAPLE_JWT_SECRET = previous;
    }
  });
}

test('public projection and write-only saved secret never echo credentials', async () => {
  using db = await createLiveTestDatabase();
  insertDestination(db.db);
  if (!db.db.query("SELECT 1 FROM sqlite_master WHERE name='backup_google_connections'").get())
    db.db.exec(GOOGLE_BACKUP_DDL);
  const previous = process.env.MAPLE_JWT_SECRET;
  process.env.MAPLE_JWT_SECRET = secret;
  try {
    const owner = await signAccessToken(
      {
        sub: '111111111111111111111111',
        email: null,
        role: 'owner',
        file_access: true,
      },
      secret,
    );
    const app = routes();
    const configUrl = `${origin}/api/cloud-backup/google/${destinationId}/config`;
    const response = await app.handle(
      new Request(configUrl, {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${owner}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          clientId: '12345-example.apps.googleusercontent.com',
          clientSecret: 'do-not-echo',
          callbackMode: 'relay',
        }),
      }),
    );
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).not.toContain('do-not-echo');
    expect(JSON.parse(body)).toMatchObject({
      clientSecretSet: true,
      mapleClientAvailable: true,
      callbackUrl: `${origin}/api/cloud-backup/google/callback`,
    });
    const cleared = await app.handle(
      new Request(configUrl, {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${owner}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          clientId: '',
          clientSecret: null,
          callbackMode: 'relay',
        }),
      }),
    );
    expect(cleared.status).toBe(200);
    expect(await cleared.json()).toMatchObject({
      clientSecretSet: false,
      connected: false,
    });
  } finally {
    process.env.MAPLE_JWT_SECRET = previous;
  }
});
