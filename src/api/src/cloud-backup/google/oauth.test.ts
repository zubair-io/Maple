import { expect, test } from 'bun:test';
import { createLiveTestDatabase } from '../../db/sqlite/test-sqlite.test-helpers.ts';
import { ObjectId } from '../../db/object-id.ts';
import { insertFolder } from '../../db/sqlite/test-sqlite.test-helpers.ts';
import { insertUser, updateUser } from '../../db/repos/auth.users.repo.ts';
import { GOOGLE_BACKUP_DDL, loadConnection, saveConfig } from './repo.ts';
import { startGoogleFlow, finishGoogleFlow, googleAccessToken, type GoogleFetch } from './oauth.ts';
import { callbackUrl, DEFAULT_GOOGLE_CONFIG, DRIVE_SCOPE, RELAY_CALLBACK } from './config.ts';

const clientId = '12345-example.apps.googleusercontent.com';
const destination = '9051f218-c3cc-419b-ab02-356e14eebd86';
async function setup(mode: 'direct' | 'relay' = 'direct', id = destination) {
  const db = await createLiveTestDatabase();
  if (!db.db.query("SELECT 1 FROM sqlite_master WHERE name='backup_google_connections'").get())
    db.db.exec(GOOGLE_BACKUP_DDL);
  const owner = await insertUser({
    email: 'owner@example.com',
    role: 'owner',
    created_at: new Date().toISOString(),
    last_seen_at: null,
  });
  db.db
    .query(
      `INSERT INTO backup_destinations(id,library_id,kind,name,created_at)
    VALUES(?,?,'google-drive','Google OAuth test',?)`,
    )
    .run(id, insertFolder(db.db), new Date().toISOString());
  await saveConfig(
    id,
    {
      ...DEFAULT_GOOGLE_CONFIG,
      clientMode: 'own',
      clientId,
      clientSecret: 'local-secret',
      callbackMode: mode,
    },
    0,
  );
  return { db, owner: owner.toString() };
}
function googleMock(
  options: {
    scope?: string;
    audience?: string;
    noRefresh?: boolean;
    beforeToken?: () => Promise<void>;
  } = {},
) {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const transport: GoogleFetch = async (url, init) => {
    requests.push({ url: url.toString(), init });
    if (url.toString().endsWith('/start'))
      return Response.json({
        ticket: 'signed-ticket',
        expiresAt: Date.now() + 300_000,
        redirectUri: RELAY_CALLBACK,
      });
    if (url.toString().endsWith('/tokeninfo'))
      return Response.json({
        aud: options.audience ?? clientId,
        scope: options.scope ?? DRIVE_SCOPE,
      });
    if (url.toString().includes('/about?'))
      return Response.json({
        user: { permissionId: 'account-1', emailAddress: 'photos@example.com' },
      });
    if (url.toString().endsWith('/token')) {
      await options.beforeToken?.();
      return Response.json({
        access_token: 'access-local-only',
        token_type: 'Bearer',
        expires_in: 30,
        ...(options.noRefresh ? {} : { refresh_token: 'refresh-local-only' }),
      });
    }
    throw new Error('Unexpected network request');
  };
  return { requests, transport };
}

test('callback origins preserve port and reject plaintext LAN and path injection', () => {
  expect(callbackUrl('https://photos.example.com:3443')).toBe(
    'https://photos.example.com:3443/api/cloud-backup/google/callback',
  );
  expect(callbackUrl('http://127.0.0.1:4000')).toContain('127.0.0.1:4000');
  for (const invalid of [
    'http://192.168.1.2',
    'https://user:secret@example.com',
    'https://example.com/other',
    'https://example.com?redirect=evil',
  ])
    expect(() => callbackUrl(invalid)).toThrow();
});
test('relay receives routing metadata only; Bun exchanges using captured relay URI and local PKCE', async () => {
  const { db, owner } = await setup('relay');
  using _handle = db;
  const mock = googleMock();
  const flow = await startGoogleFlow(
    destination,
    owner,
    'https://photos.example.com',
    mock.transport,
  );
  const relayRequest = JSON.parse(String(mock.requests[0]!.init!.body));
  expect(Object.keys(relayRequest).sort()).toEqual(['challenge', 'clientId', 'nonce', 'returnUrl']);
  expect(JSON.stringify(relayRequest)).not.toContain('local-secret');
  expect(relayRequest.challenge).toHaveLength(43);
  expect(flow.authorizationUrl).toStartWith(
    'https://mapleeditor.com/connect/google-drive?ngsw-bypass=true#',
  );
  await finishGoogleFlow(
    'signed-ticket',
    flow.cookie,
    'authorization-code',
    false,
    'https://photos.example.com',
    mock.transport,
  );
  const params = mock.requests.find((r) => r.url.endsWith('/token'))!.init!.body as URLSearchParams;
  expect(params.get('redirect_uri')).toBe(RELAY_CALLBACK);
  expect(params.get('client_secret')).toBe('local-secret');
  expect(params.get('code_verifier')).toHaveLength(43);
  expect((await loadConnection(destination)).config.refreshToken).toBe('refresh-local-only');
  const stored = db.db.query('SELECT credentials FROM backup_google_connections').get() as {
    credentials: string;
  };
  expect(stored.credentials).not.toContain('local-secret');
  expect(stored.credentials).not.toContain('refresh-local-only');
});
test('cookie mismatch cannot consume a flow; successful callback rejects replay', async () => {
  const { db, owner } = await setup();
  using _handle = db;
  const mock = googleMock();
  const flow = await startGoogleFlow(
    destination,
    owner,
    'https://photos.example.com',
    mock.transport,
  );
  const state = new URL(flow.authorizationUrl).searchParams.get('state')!;
  await expect(
    finishGoogleFlow(
      state,
      'A'.repeat(43),
      'code',
      false,
      'https://photos.example.com',
      mock.transport,
    ),
  ).rejects.toThrow('browser session');
  await finishGoogleFlow(
    state,
    flow.cookie,
    'code',
    false,
    'https://photos.example.com',
    mock.transport,
  );
  await expect(
    finishGoogleFlow(
      state,
      flow.cookie,
      'code',
      false,
      'https://photos.example.com',
      mock.transport,
    ),
  ).rejects.toThrow();
});
test('current owner authority and credential epoch fence callback attachment', async () => {
  const { db, owner } = await setup();
  using _handle = db;
  const mock = googleMock();
  const flow = await startGoogleFlow(
    destination,
    owner,
    'https://photos.example.com',
    mock.transport,
  );
  await updateUser(new ObjectId(owner), { role: 'member' });
  await expect(
    finishGoogleFlow(
      new URL(flow.authorizationUrl).searchParams.get('state')!,
      flow.cookie,
      'code',
      false,
      'https://photos.example.com',
      mock.transport,
    ),
  ).rejects.toThrow('active Maple owner');
  expect(mock.requests).toHaveLength(0);
});
test('disconnect racing a successful token response cannot save credentials', async () => {
  const { db, owner } = await setup();
  using _handle = db;
  const mock = googleMock({
    beforeToken: async () => {
      const connection = await loadConnection(destination);
      await saveConfig(destination, { ...connection.config, refreshToken: null }, connection.epoch);
    },
  });
  const flow = await startGoogleFlow(
    destination,
    owner,
    'https://photos.example.com',
    mock.transport,
  );
  await expect(
    finishGoogleFlow(
      new URL(flow.authorizationUrl).searchParams.get('state')!,
      flow.cookie,
      'code',
      false,
      'https://photos.example.com',
      mock.transport,
    ),
  ).rejects.toThrow('connection changed');
  expect((await loadConnection(destination)).config.refreshToken).toBeNull();
});

test('domain change during exchange prevents late token attachment', async () => {
  const { db, owner } = await setup();
  using _handle = db;
  let origin = 'https://photos.example.com';
  const mock = googleMock({
    beforeToken: async () => {
      origin = 'https://new.example.com';
    },
  });
  const flow = await startGoogleFlow(destination, owner, origin, mock.transport);
  await expect(
    finishGoogleFlow(
      new URL(flow.authorizationUrl).searchParams.get('state')!,
      flow.cookie,
      'code',
      false,
      async () => origin,
      mock.transport,
    ),
  ).rejects.toThrow('Domain changed');
  expect((await loadConnection(destination)).config.refreshToken).toBeNull();
});
for (const bad of [
  { scope: `${DRIVE_SCOPE} https://www.googleapis.com/auth/drive` },
  { audience: 'foreign-client' },
  { noRefresh: true },
]) {
  test(`invalid Google grant is rejected (${Object.keys(bad)[0]})`, async () => {
    const { db, owner } = await setup();
    using _handle = db;
    const mock = googleMock(bad);
    const flow = await startGoogleFlow(
      destination,
      owner,
      'https://photos.example.com',
      mock.transport,
    );
    await expect(
      finishGoogleFlow(
        new URL(flow.authorizationUrl).searchParams.get('state')!,
        flow.cookie,
        'code',
        false,
        'https://photos.example.com',
        mock.transport,
      ),
    ).rejects.toThrow();
    expect((await loadConnection(destination)).config.refreshToken).toBeNull();
  });
}
test('refresh goes straight to Google and preserves an omitted replacement token', async () => {
  const { db } = await setup();
  using _handle = db;
  const connection = await loadConnection(destination);
  await saveConfig(
    destination,
    {
      ...connection.config,
      refreshToken: 'saved-refresh',
      accountId: 'account-1',
    },
    connection.epoch,
  );
  const mock = googleMock({ noRefresh: true });
  expect(await googleAccessToken(destination, mock.transport)).toBe('access-local-only');
  expect(mock.requests.every((r) => !r.url.includes('mapleeditor'))).toBe(true);
  const params = mock.requests[0]!.init!.body as URLSearchParams;
  expect(params.get('refresh_token')).toBe('saved-refresh');
  expect(params.get('client_secret')).toBe('local-secret');
  expect((await loadConnection(destination)).config.refreshToken).toBe('saved-refresh');
});

test('revoked offline grants become disconnected and require fresh consent', async () => {
  const { db } = await setup();
  using _handle = db;
  const connection = await loadConnection(destination);
  await saveConfig(
    destination,
    { ...connection.config, refreshToken: 'revoked-refresh', accountId: 'account-1' },
    connection.epoch,
  );
  await expect(
    googleAccessToken(destination, async () =>
      Response.json({ error: 'invalid_grant' }, { status: 400 }),
    ),
  ).rejects.toThrow('reconnect');
  expect((await loadConnection(destination)).config.refreshToken).toBeNull();
});

for (const lateResult of ['rotated-token', 'invalid_grant'] as const) {
  test(`fresh consent fences an already running renewal (${lateResult}) with unchanged application settings`, async () => {
    const id = crypto.randomUUID();
    const { db, owner } = await setup('direct', id);
    using _handle = db;
    const initial = await loadConnection(id);
    await saveConfig(
      id,
      { ...initial.config, refreshToken: 'old-grant', accountId: 'account-1' },
      initial.epoch,
    );
    const previous = await loadConnection(id);
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const mock = googleMock();
    const renewal: GoogleFetch = async (url, init) => {
      if (url.toString().endsWith('/token')) {
        started.resolve();
        await release.promise;
        return lateResult === 'invalid_grant'
          ? Response.json({ error: 'invalid_grant' }, { status: 400 })
          : Response.json({
              access_token: 'stale-access',
              refresh_token: 'stale-rotation',
              token_type: 'Bearer',
              expires_in: 3600,
            });
      }
      return mock.transport(url, init);
    };
    const pending = googleAccessToken(id, renewal).then(
      (token) => ({ token, error: null }),
      (error: Error) => ({ token: null, error }),
    );
    await started.promise;
    const consent: GoogleFetch = async (url, init) =>
      url.toString().endsWith('/token')
        ? Response.json({
            access_token: 'new-access',
            refresh_token: 'new-consent',
            token_type: 'Bearer',
            expires_in: 3600,
          })
        : mock.transport(url, init);
    const flow = await startGoogleFlow(id, owner, 'https://photos.example.com', consent);
    await finishGoogleFlow(
      new URL(flow.authorizationUrl).searchParams.get('state')!,
      flow.cookie,
      'new-code',
      false,
      'https://photos.example.com',
      consent,
    );
    release.resolve();
    const stale = await pending;
    expect(stale.token).toBeNull();
    expect(stale.error?.message).toContain('connection changed');
    const current = await loadConnection(id);
    expect(current.epoch).toBe(previous.epoch + 1);
    expect(current.config.refreshToken).toBe('new-consent');
    expect(
      await googleAccessToken(id, async () => {
        throw new Error('New consent should remain cached');
      }),
    ).toBe('new-access');
    expect(
      db.db
        .query(
          'SELECT refresh_owner,refresh_until FROM backup_google_connections WHERE destination_id=?',
        )
        .get(id),
    ).toEqual({ refresh_owner: null, refresh_until: 0 });
  });
}
