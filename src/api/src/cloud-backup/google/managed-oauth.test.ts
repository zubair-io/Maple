import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { updateUser } from '../../db/repos/auth.users.repo.ts';
import { ObjectId } from '../../db/object-id.ts';
import { loadConnection, saveConfig } from './repo.ts';
import { DEFAULT_GOOGLE_CONFIG, DRIVE_SCOPE, RELAY_CALLBACK } from './config.ts';
import { startGoogleFlow, finishGoogleFlow, googleAccessToken } from './oauth.ts';
import { managedFixture, managedServer, managedState, managedId } from './managed.test-helpers.ts';
import { seal } from './secrets.ts';

const origin = 'https://photos.example.com';
async function connect(
  f: Awaited<ReturnType<typeof managedFixture>>,
  server: ReturnType<typeof managedServer>,
) {
  const flow = await startGoogleFlow(f.destination.id, f.owner, origin, server.transport);
  await finishGoogleFlow(
    managedState(flow.authorizationUrl),
    flow.cookie,
    'private-code',
    false,
    origin,
    server.transport,
  );
  return flow;
}

test('managed connect provisions metadata and exchanges PKCE through the fixed proxy while locally verifying Google identity', async () => {
  const f = await managedFixture();
  using _database = f.live;
  const server = managedServer();
  const flow = await connect(f, server);
  const request = server.requests.find((r) => r.url.endsWith('/exchange'))!;
  const body = JSON.parse(String(request.init.body));
  expect(Object.keys(body).sort()).toEqual(['code', 'ticket', 'verifier']);
  expect(body.code).toBe('private-code');
  expect(body.ticket).toBe(managedState(flow.authorizationUrl));
  const routing = JSON.parse(
    String(server.requests.find((r) => r.url.endsWith('/start'))!.init.body),
  );
  expect(createHash('sha256').update(body.verifier).digest('base64url')).toBe(routing.challenge);
  expect(routing).toMatchObject({
    clientId: managedId,
    returnUrl: `${origin}/api/cloud-backup/google/callback`,
  });
  expect(server.requests.some((r) => r.url === 'https://oauth2.googleapis.com/token')).toBe(false);
  expect(server.requests.some((r) => r.url === 'https://oauth2.googleapis.com/tokeninfo')).toBe(
    true,
  );
  expect((await loadConnection(f.destination.id)).config).toMatchObject({
    clientMode: 'maple',
    clientId: managedId,
    clientSecret: '',
    callbackMode: 'relay',
    refreshToken: 'exchange-refresh',
    relayGrant: 'exchange-grant',
    accountId: 'managed-account',
  });
  const stored = f.live.db.query('SELECT credentials FROM backup_google_connections').get() as {
    credentials: string;
  };
  expect(stored.credentials).not.toContain('exchange-refresh');
  expect(stored.credentials).not.toContain('exchange-grant');
  for (const r of server.requests) {
    expect(r.init.redirect).toBe('error');
    expect(r.init.signal).toBeInstanceOf(AbortSignal);
    expect(r.url).not.toContain('private-code');
  }
});

test('managed renewal rotates refresh token and grant atomically and survives loss of the in-memory cache', async () => {
  const f = await managedFixture();
  using _database = f.live;
  const server = managedServer();
  await connect(f, server);
  expect(await googleAccessToken(f.destination.id, server.transport)).toBe('renewal-access');
  const first = server.requests.find((r) => r.url.endsWith('/refresh'))!;
  expect(JSON.parse(String(first.init.body))).toEqual({
    refreshToken: 'exchange-refresh',
    relayGrant: 'exchange-grant',
  });
  const saved = await loadConnection(f.destination.id);
  expect(saved.config).toMatchObject({
    refreshToken: 'rotated-refresh',
    relayGrant: 'rotated-grant',
  });
  // A reconnecting process has no access-token cache; all renewal authority is encrypted in SQLite.
  expect(await saveConfig(f.destination.id, saved.config, saved.epoch)).toBe(true);
  server.controls.renewal = {
    access_token: 'after-restart',
    token_type: 'Bearer',
    expires_in: 30,
    relayGrant: 'same-token-grant',
  };
  expect(await googleAccessToken(f.destination.id, server.transport)).toBe('after-restart');
  const second = server.requests.filter((r) => r.url.endsWith('/refresh')).at(-1)!;
  expect(JSON.parse(String(second.init.body))).toEqual({
    refreshToken: 'rotated-refresh',
    relayGrant: 'rotated-grant',
  });
  expect((await loadConnection(f.destination.id)).config).toMatchObject({
    refreshToken: 'rotated-refresh',
    relayGrant: 'same-token-grant',
  });
});

test('a fresh Bun process renews using the encrypted token and relay grant from the persistent database', async () => {
  const f = await managedFixture('file');
  using _database = f.live;
  const server = managedServer();
  await connect(f, server);
  await googleAccessToken(f.destination.id, server.transport);
  const script = `
    import { openSqlitePool, closeSqlitePool } from './src/db/sqlite/index.ts';
    import { googleAccessToken } from './src/cloud-backup/google/oauth.ts';
    import { managedServer } from './src/cloud-backup/google/managed.test-helpers.ts';
    await openSqlitePool({path:Bun.argv[1],readers:1});
    try {
      const server=managedServer();
      server.controls.renewal={access_token:'fresh-process-access',token_type:'Bearer',expires_in:30,relayGrant:'fresh-process-grant'};
      const token=await googleAccessToken(Bun.argv[2],server.transport);
      console.log(JSON.stringify({token,renewal:JSON.parse(String(server.requests[0].init.body))}));
    } finally { closeSqlitePool(); }
  `;
  const child = Bun.spawn([process.execPath, '--eval', script, f.live.path, f.destination.id], {
    cwd: new URL('../../..', import.meta.url).pathname,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [output, errors, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  expect(errors).toBe('');
  expect(exitCode).toBe(0);
  expect(JSON.parse(output)).toEqual({
    token: 'fresh-process-access',
    renewal: { refreshToken: 'rotated-refresh', relayGrant: 'rotated-grant' },
  });
  expect((await loadConnection(f.destination.id)).config).toMatchObject({
    refreshToken: 'rotated-refresh',
    relayGrant: 'fresh-process-grant',
  });
});

for (const error of ['invalid_grant', 'invalid_proof']) {
  test(`managed ${error} clears local renewal authority without returning provider error bodies`, async () => {
    const f = await managedFixture();
    using _database = f.live;
    const server = managedServer();
    await connect(f, server);
    server.controls.renewal = { error, error_description: 'private-token-secret' };
    server.controls.renewalStatus = 400;
    await expect(googleAccessToken(f.destination.id, server.transport)).rejects.toThrow(
      'reconnect Google Drive',
    );
    expect((await loadConnection(f.destination.id)).config).toMatchObject({
      refreshToken: null,
      relayGrant: null,
    });
  });
}

for (const invalid of ['scope', 'audience', 'grant'] as const) {
  test(`managed callback rejects invalid ${invalid} before persisting renewal credentials`, async () => {
    const f = await managedFixture();
    using _database = f.live;
    const server = managedServer();
    const changes = {
      scope: () => {
        server.controls.scope = DRIVE_SCOPE + ' https://www.googleapis.com/auth/drive';
      },
      audience: () => {
        server.controls.audience = 'other.apps.googleusercontent.com';
      },
      grant: () => {
        delete server.controls.exchange.relayGrant;
      },
    };
    changes[invalid]();
    await expect(connect(f, server)).rejects.toThrow();
    expect((await loadConnection(f.destination.id)).config.refreshToken).toBeNull();
  });
}

test('managed callback owner revocation after token processing still prevents attachment', async () => {
  const f = await managedFixture();
  using _database = f.live;
  const server = managedServer();
  server.controls.beforeExchange = async () => {
    await updateUser(new ObjectId(f.owner), { role: 'member' });
  };
  await expect(connect(f, server)).rejects.toThrow('active Maple owner');
  expect((await loadConnection(f.destination.id)).config.refreshToken).toBeNull();
});

test('switching modes during managed consent or renewal fences the old token result', async () => {
  const f = await managedFixture();
  using _database = f.live;
  const server = managedServer();
  const own = {
    ...DEFAULT_GOOGLE_CONFIG,
    clientMode: 'own' as const,
    clientId: '12345-own.apps.googleusercontent.com',
    clientSecret: 'own-secret',
  };
  server.controls.beforeExchange = async () => {
    const saved = await loadConnection(f.destination.id);
    await saveConfig(f.destination.id, own, saved.epoch);
  };
  await expect(connect(f, server)).rejects.toThrow('connection changed');
  expect((await loadConnection(f.destination.id)).config).toMatchObject({
    clientMode: 'own',
    refreshToken: null,
    relayGrant: null,
  });
  const current = await loadConnection(f.destination.id);
  await saveConfig(
    f.destination.id,
    { ...DEFAULT_GOOGLE_CONFIG, clientId: managedId },
    current.epoch,
  );
  server.controls.beforeExchange = async () => {};
  await connect(f, server);
  server.controls.beforeRefresh = async () => {
    const saved = await loadConnection(f.destination.id);
    await saveConfig(f.destination.id, own, saved.epoch);
  };
  await expect(googleAccessToken(f.destination.id, server.transport)).rejects.toThrow(
    'connection changed',
  );
  expect((await loadConnection(f.destination.id)).config).toMatchObject({
    clientMode: 'own',
    refreshToken: null,
    relayGrant: null,
  });
});

test('managed metadata changes during provisioning cannot overwrite newer application settings', async () => {
  const f = await managedFixture();
  using _database = f.live;
  const server = managedServer();
  server.controls.beforeMetadata = async () => {
    await saveConfig(
      f.destination.id,
      {
        ...DEFAULT_GOOGLE_CONFIG,
        clientMode: 'own',
        clientId: '12345-own.apps.googleusercontent.com',
        clientSecret: 'own-secret',
      },
      0,
    );
  };
  await expect(
    startGoogleFlow(f.destination.id, f.owner, origin, server.transport),
  ).rejects.toThrow('configuration changed');
  expect((await loadConnection(f.destination.id)).config.clientMode).toBe('own');
  expect(server.requests.some((r) => r.url.endsWith('/start'))).toBe(false);
});

test('managed metadata cannot silently migrate an already attached backup folder to another client', async () => {
  const f = await managedFixture();
  using _database = f.live;
  const server = managedServer();
  await saveConfig(
    f.destination.id,
    { ...DEFAULT_GOOGLE_CONFIG, clientId: '12345-previous.apps.googleusercontent.com' },
    0,
  );
  f.live.db
    .query('UPDATE backup_destinations SET root_id=? WHERE id=?')
    .run('attached-root', f.destination.id);
  await expect(
    startGoogleFlow(f.destination.id, f.owner, origin, server.transport),
  ).rejects.toThrow('Create another destination');
  expect((await loadConnection(f.destination.id)).config.clientId).toBe(
    '12345-previous.apps.googleusercontent.com',
  );
  expect(RELAY_CALLBACK).toBe('https://mapleeditor.com/api/connect/google-drive/callback');
});

test('legacy encrypted configurations retain their own client mode and direct callback settings', async () => {
  const f = await managedFixture();
  using _database = f.live;
  const legacy = {
    clientId: '12345-own.apps.googleusercontent.com',
    clientSecret: 'own-secret',
    callbackMode: 'direct',
    refreshToken: 'legacy-refresh',
    accountId: 'legacy-account',
    accountEmail: null,
  };
  await f.repo.db.write(
    'INSERT INTO backup_google_connections(destination_id,epoch,credentials) VALUES(?,1,?)',
    [f.destination.id, await seal(legacy, f.destination.id)],
  );
  expect((await loadConnection(f.destination.id)).config).toMatchObject({
    ...legacy,
    clientMode: 'own',
    relayGrant: null,
  });
});

test('owner revocation during managed metadata lookup prevents provisioning and pending authorization', async () => {
  const f = await managedFixture();
  using _database = f.live;
  const server = managedServer();
  server.controls.beforeMetadata = async () => {
    await updateUser(new ObjectId(f.owner), { role: 'member' });
  };
  await expect(
    startGoogleFlow(f.destination.id, f.owner, origin, server.transport),
  ).rejects.toThrow('active Maple owner');
  expect((await loadConnection(f.destination.id)).epoch).toBe(0);
  expect(f.live.db.query('SELECT * FROM backup_google_oauth').all()).toEqual([]);
});

test('destination removal during managed startup cannot persist credentials or an authorization flow', async () => {
  const f = await managedFixture();
  using _database = f.live;
  const server = managedServer();
  server.controls.beforeMetadata = async () => {
    await f.repo.db.write('DELETE FROM backup_destinations WHERE id=?', [f.destination.id]);
  };
  await expect(
    startGoogleFlow(f.destination.id, f.owner, origin, server.transport),
  ).rejects.toThrow('configuration changed');
  expect(f.live.db.query('SELECT * FROM backup_google_connections').all()).toEqual([]);
  expect(f.live.db.query('SELECT * FROM backup_google_oauth').all()).toEqual([]);
});

for (const change of ['delete', 'configuration'] as const) {
  test(`${change} while obtaining a relay ticket prevents stale pending authorization`, async () => {
    const f = await managedFixture();
    using _database = f.live;
    const server = managedServer();
    server.controls.beforeStart = async () => {
      if (change === 'delete') {
        await f.repo.db.write('DELETE FROM backup_destinations WHERE id=?', [f.destination.id]);
        return;
      }
      const saved = await loadConnection(f.destination.id);
      await saveConfig(
        f.destination.id,
        { ...saved.config, clientMode: 'own', clientSecret: 'own-secret' },
        saved.epoch,
      );
    };
    await expect(
      startGoogleFlow(f.destination.id, f.owner, origin, server.transport),
    ).rejects.toThrow('destination or configuration changed');
    expect(f.live.db.query('SELECT * FROM backup_google_oauth').all()).toEqual([]);
  });
}

test('managed service failures hide transport details and keep the saved renewal grant for a later retry', async () => {
  const f = await managedFixture();
  using _database = f.live;
  const server = managedServer();
  await connect(f, server);
  server.controls.beforeRefresh = async () => {
    throw new Error('private-refresh-token transport detail');
  };
  const failure = await googleAccessToken(f.destination.id, server.transport).catch(
    (error) => error,
  );
  expect(failure.message).toBe('The Maple Google token service is unavailable; retry shortly.');
  expect((await loadConnection(f.destination.id)).config).toMatchObject({
    refreshToken: 'exchange-refresh',
    relayGrant: 'exchange-grant',
  });
  server.controls.beforeRefresh = async () => {};
  expect(await googleAccessToken(f.destination.id, server.transport)).toBe('renewal-access');
});
