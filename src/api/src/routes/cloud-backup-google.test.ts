import { expect, test } from 'bun:test';
import { Elysia } from 'elysia';
import { signAccessToken } from '../auth/tokens.ts';
import { createLiveTestDatabase, insertFolder } from '../db/sqlite/test-sqlite.test-helpers.ts';
import { buildGoogleBackupRoutes } from './cloud-backup-google.ts';
import { GOOGLE_BACKUP_DDL, saveConfig } from '../cloud-backup/google/repo.ts';
import { insertUser } from '../db/repos/auth.users.repo.ts';
import {
  DEFAULT_GOOGLE_CONFIG,
  DRIVE_SCOPE,
  GoogleFlowUnavailable,
} from '../cloud-backup/google/config.ts';
import type { GoogleFetch } from '../cloud-backup/google/oauth.ts';
import { BackupRepository } from '../cloud-backup/repository.ts';

const destinationId = 'e9aa2f31-ccdd-4e77-9999-0619988bac3c';
const origin = 'https://photos.example.com';
const secret = 'google-route-test-secret-must-be-long';
function routes(
  transport?: GoogleFetch,
  connectionRestored: (id: string) => Promise<void> = (id) =>
    new BackupRepository().clearResolvedConnectionErrors(id),
) {
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
    connectionRestored,
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
    expect(redirect.searchParams.get('googleError')).toBe(new GoogleFlowUnavailable().message);
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
      const restored: string[] = [];
      const app = routes(
        async (url, init) => {
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
        },
        async (id) => {
          restored.push(id);
        },
      );
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
      expect(restored).toEqual([destinationId]);
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

async function repeatHarness(options: { tokenDelay?: Promise<void>; failRootOnce?: boolean } = {}) {
  const db = await createLiveTestDatabase();
  insertDestination(db.db);
  if (!db.db.query("SELECT 1 FROM sqlite_master WHERE name='backup_google_connections'").get())
    db.db.exec(GOOGLE_BACKUP_DDL);
  const user = await insertUser({
    email: 'repeat-owner@example.com',
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
  const bearer = await signAccessToken(
    { sub: user.toHexString(), email: null, role: 'owner', file_access: true },
    secret,
  );
  const exchanges: string[] = [];
  const restored: string[] = [];
  const rootFailures = { remaining: options.failRootOnce ? 1 : 0 };
  const app = routes(
    async (url, init) => {
      const request = new URL(url);
      if (request.pathname.endsWith('/generateIds')) {
        if (rootFailures.remaining-- > 0) return new Response(null, { status: 500 });
        return Response.json({ ids: ['repeat-created-root'] });
      }
      if (request.pathname.endsWith('/files/repeat-created-root'))
        return new Response(null, { status: 404 });
      if (request.pathname.endsWith('/files') && init?.method === 'POST')
        return Response.json({ id: JSON.parse(String(init.body)).id });
      if (url.toString().endsWith('/token')) {
        exchanges.push(String(init?.body));
        await options.tokenDelay;
        return Response.json({
          access_token: 'token-local',
          refresh_token: 'refresh-local',
          token_type: 'Bearer',
          expires_in: 3600,
        });
      }
      if (url.toString().endsWith('/tokeninfo'))
        return Response.json({
          aud: '12345-example.apps.googleusercontent.com',
          scope: DRIVE_SCOPE,
        });
      return Response.json({ user: { permissionId: 'account-1' } });
    },
    async (id) => {
      restored.push(id);
    },
  );
  const start = async () => {
    const started = await app.handle(
      new Request(`${origin}/api/cloud-backup/google/${destinationId}/start`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${bearer}`, Origin: origin },
      }),
    );
    expect(started.status).toBe(200);
    return {
      cookie: started.headers.get('set-cookie')!.split(';')[0]!,
      state: new URL((await started.json()).authorizationUrl).searchParams.get('state')!,
    };
  };
  const visit = (state: string, cookie?: string, query = 'code=code') =>
    app.handle(
      new Request(`${origin}/api/cloud-backup/google/callback?${query}&state=${state}`, {
        headers: cookie ? { Cookie: cookie } : {},
      }),
    );
  return { db, app, bearer, exchanges, restored, start, visit };
}
const connectedLocation = `${origin}/settings/backup?connected=${destinationId}`;
const googleError = (response: Response) =>
  new URL(response.headers.get('location')!).searchParams.get('googleError');
async function withSecret(run: () => Promise<void>) {
  const previous = process.env.MAPLE_JWT_SECRET;
  process.env.MAPLE_JWT_SECRET = secret;
  try {
    await run();
  } finally {
    process.env.MAPLE_JWT_SECRET = previous;
  }
}

test('a repeated callback after a completed connect reports the connection without authorizing again (#5706)', () =>
  withSecret(async () => {
    const harness = await repeatHarness();
    using _handle = harness.db;
    const { exchanges, restored, start, visit } = harness;
    const first = await start();
    const connected = await visit(first.state, first.cookie);
    expect(connected.headers.get('location')).toBe(connectedLocation);
    expect(connected.headers.get('set-cookie')).toContain('Max-Age=0');
    expect(exchanges).toHaveLength(1);

    for (const cookie of [undefined, first.cookie]) {
      const repeated = await visit(first.state, cookie);
      expect(repeated.status).toBe(303);
      expect(repeated.headers.get('location')).toBe(connectedLocation);
      expect(repeated.headers.get('set-cookie')).toBeNull();
      expect(repeated.headers.get('cache-control')).toBe('no-store');
    }
    const deniedRepeat = await visit(first.state, undefined, 'error=access_denied');
    expect(deniedRepeat.headers.get('location')).toBe(connectedLocation);
    expect(exchanges).toHaveLength(1);
    expect(restored).toEqual([destinationId]);

    const malformedCode = await visit(first.state, undefined, `code=${'c'.repeat(4097)}`);
    expect(googleError(malformedCode)).toBe('Invalid Google callback.');

    const unknown = await visit('never-issued-state');
    expect(googleError(unknown)).toBe(new GoogleFlowUnavailable().message);
    expect(unknown.headers.get('set-cookie')).toContain('Max-Age=0');
    const unknownWithCookie = await visit('never-issued-state', first.cookie);
    expect(googleError(unknownWithCookie)).toBe(new GoogleFlowUnavailable().message);

    const pending = await start();
    const repeatedWhilePending = await visit(first.state, pending.cookie);
    expect(repeatedWhilePending.headers.get('location')).toBe(connectedLocation);
    expect(repeatedWhilePending.headers.get('set-cookie')).toBeNull();
    const second = await visit(pending.state, pending.cookie);
    expect(second.headers.get('location')).toBe(connectedLocation);
    expect(exchanges).toHaveLength(2);
    expect(googleError(await visit(first.state))).toBe(new GoogleFlowUnavailable().message);
    expect((await visit(pending.state)).headers.get('location')).toBe(connectedLocation);

    const disconnected = await harness.app.handle(
      new Request(`${origin}/api/cloud-backup/google/${destinationId}/disconnect`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${harness.bearer}` },
      }),
    );
    expect(disconnected.status).toBe(200);
    expect(googleError(await visit(pending.state))).toBe(new GoogleFlowUnavailable().message);
    expect(exchanges).toHaveLength(2);
  }));

test('a double visit racing the first callback lands both on the connected page', () =>
  withSecret(async () => {
    const tokenDelay = Promise.withResolvers<void>();
    const harness = await repeatHarness({ tokenDelay: tokenDelay.promise });
    using _handle = harness.db;
    const first = await harness.start();
    const original = harness.visit(first.state, first.cookie);
    while (harness.exchanges.length === 0) await Bun.sleep(1);
    const duplicate = harness.visit(first.state, first.cookie);
    await Bun.sleep(10);
    tokenDelay.resolve();
    const [winner, loser] = await Promise.all([original, duplicate]);
    expect(winner.headers.get('location')).toBe(connectedLocation);
    expect(loser.headers.get('location')).toBe(connectedLocation);
    expect(loser.headers.get('set-cookie')).toBeNull();
    expect(harness.exchanges).toHaveLength(1);
    expect(harness.restored).toEqual([destinationId]);
  }));

test('a repeat after a connect whose backup folder setup failed keeps an error', () =>
  withSecret(async () => {
    const harness = await repeatHarness({ failRootOnce: true });
    using _handle = harness.db;
    const first = await harness.start();
    const failed = await harness.visit(first.state, first.cookie);
    expect(googleError(failed)).not.toBeNull();
    expect(harness.restored).toEqual([]);
    expect(googleError(await harness.visit(first.state))).toBe(new GoogleFlowUnavailable().message);
  }));

test('a repeat for a destination that no longer exists keeps an error', () =>
  withSecret(async () => {
    const harness = await repeatHarness();
    using _handle = harness.db;
    const first = await harness.start();
    expect((await harness.visit(first.state, first.cookie)).headers.get('location')).toBe(
      connectedLocation,
    );
    harness.db.db.query('DELETE FROM backup_destinations WHERE id=?').run(destinationId);
    expect(googleError(await harness.visit(first.state))).toBe(new GoogleFlowUnavailable().message);
  }));

test('a malformed callback state stays an invalid callback', async () => {
  const response = await routes().handle(
    new Request(`${origin}/api/cloud-backup/google/callback?code=code&state=`),
  );
  expect(googleError(response)).toBe('Invalid Google callback.');
});
