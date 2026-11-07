import { expect, test } from 'bun:test';
import { loadConnection, saveConfig } from './repo.ts';
import { publicConfig, withoutCredentials } from './config.ts';
import {
  finishGoogleFlow,
  forgetGoogleAccessToken,
  googleAccessToken,
  startGoogleFlow,
} from './oauth.ts';
import { managedFixture, managedServer, managedState } from './managed.test-helpers.ts';
import { seal } from './secrets.ts';
import type { GoogleFetch } from './oauth.ts';

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
  forgetGoogleAccessToken(f.destination.id);
}

const transient: Record<string, (server: ReturnType<typeof managedServer>) => GoogleFetch> = {
  'relay temporarily_unavailable': (server) => {
    server.controls.renewal = { error: 'temporarily_unavailable' };
    server.controls.renewalStatus = 502;
    return server.transport;
  },
  'relay broker_unavailable': (server) => {
    server.controls.renewal = { error: 'broker_unavailable' };
    server.controls.renewalStatus = 503;
    return server.transport;
  },
  'relay invalid_client': (server) => {
    server.controls.renewal = { error: 'invalid_client' };
    server.controls.renewalStatus = 400;
    return server.transport;
  },
  'relay rate limit': (server) => {
    server.controls.renewal = { error: 'rate_limited' };
    server.controls.renewalStatus = 429;
    return server.transport;
  },
  'an HTML proxy error page': (server) => async (input, init) =>
    input.toString().endsWith('/refresh')
      ? new Response('<html>502 Bad Gateway</html>', { status: 502 })
      : server.transport(input, init),
  'a network failure': (server) => async (input, init) => {
    if (input.toString().endsWith('/refresh')) throw new TypeError('fetch failed');
    return server.transport(input, init);
  },
  'an unusable access token': (server) => {
    server.controls.renewal = { relayGrant: 'grant', token_type: 'Bearer', expires_in: 30 };
    return server.transport;
  },
};
for (const [failure, arrange] of Object.entries(transient)) {
  test(`${failure} during renewal keeps the stored credentials`, async () => {
    const f = await managedFixture();
    using _database = f.live;
    const server = managedServer();
    await connect(f, server);
    const transport = arrange(server);
    await expect(googleAccessToken(f.destination.id, transport)).rejects.toThrow();
    expect((await loadConnection(f.destination.id)).config).toMatchObject({
      refreshToken: 'exchange-refresh',
      relayGrant: 'exchange-grant',
      disconnect: null,
    });
  });
}

const causes = {
  invalid_grant: "Google expired or revoked Maple's Drive authorization (invalid_grant) at ",
  invalid_proof: "The Maple token service rejected this server's renewal grant (invalid_proof) at ",
};
for (const [reason, cause] of Object.entries(causes)) {
  test(`a ${reason} rejection records its cause and time for every later attempt`, async () => {
    const f = await managedFixture();
    using _database = f.live;
    const server = managedServer();
    await connect(f, server);
    server.controls.renewal = { error: reason };
    server.controls.renewalStatus = 400;
    const before = Date.now();
    const first = await googleAccessToken(f.destination.id, server.transport).catch(
      (error: Error) => error.message,
    );
    const { config } = await loadConnection(f.destination.id);
    expect(config).toMatchObject({ refreshToken: null, relayGrant: null });
    expect(config.disconnect?.reason).toBe(reason as 'invalid_grant' | 'invalid_proof');
    expect(config.disconnect!.at).toBeGreaterThanOrEqual(before);
    const at = new Date(config.disconnect!.at).toISOString().replace(/\.\d{3}Z$/, 'Z');
    const expected = `${cause}${at}. Reconnect Google Drive to resume backup.`;
    expect(first).toBe(expected);
    const later = await googleAccessToken(f.destination.id, server.transport).catch(
      (error: Error) => error.message,
    );
    expect(later).toBe(expected);
    expect(publicConfig(config, null)).toMatchObject({
      connected: false,
      disconnect: { reason, at: new Date(config.disconnect!.at).toISOString(), message: expected },
    });
  });
}

test('a missing relay grant records missing_grant instead of a generic reconnect', async () => {
  const f = await managedFixture();
  using _database = f.live;
  const server = managedServer();
  await connect(f, server);
  const { config } = await loadConnection(f.destination.id);
  f.live.db
    .query('UPDATE backup_google_connections SET credentials=?')
    .run(await seal({ ...config, relayGrant: null }, f.destination.id));
  await expect(googleAccessToken(f.destination.id, server.transport)).rejects.toThrow(
    '(missing_grant) at ',
  );
  expect((await loadConnection(f.destination.id)).config.disconnect?.reason).toBe('missing_grant');
});

test('reconnecting clears the recorded cause', async () => {
  const f = await managedFixture();
  using _database = f.live;
  const server = managedServer();
  await connect(f, server);
  server.controls.renewal = { error: 'invalid_grant' };
  server.controls.renewalStatus = 400;
  await expect(googleAccessToken(f.destination.id, server.transport)).rejects.toThrow();
  await connect(f, server);
  expect((await loadConnection(f.destination.id)).config).toMatchObject({
    refreshToken: 'exchange-refresh',
    disconnect: null,
  });
});

test('disconnecting or changing settings keeps the recorded cause until a reconnect', async () => {
  const f = await managedFixture();
  using _database = f.live;
  const server = managedServer();
  await connect(f, server);
  server.controls.renewal = { error: 'invalid_proof' };
  server.controls.renewalStatus = 400;
  await expect(googleAccessToken(f.destination.id, server.transport)).rejects.toThrow();
  const current = await loadConnection(f.destination.id);
  await saveConfig(f.destination.id, withoutCredentials(current.config), current.epoch);
  expect((await loadConnection(f.destination.id)).config.disconnect).toEqual(
    current.config.disconnect,
  );
  expect(current.config.disconnect?.reason).toBe('invalid_proof');
});

for (const [label, disconnect] of Object.entries({
  'an unknown reason': { reason: 'future_reason', at: 1 },
  'a non-numeric time': { reason: 'invalid_grant', at: 'yesterday' },
  'an out-of-range time': { reason: 'invalid_grant', at: 1e20 },
})) {
  test(`a stored disconnect with ${label} loads as no recorded cause`, async () => {
    const f = await managedFixture();
    using _database = f.live;
    f.live.db
      .query(
        'INSERT INTO backup_google_connections(destination_id,epoch,credentials) VALUES(?,1,?)',
      )
      .run(f.destination.id, await seal({ clientMode: 'maple', disconnect }, f.destination.id));
    const { config } = await loadConnection(f.destination.id);
    expect(config.disconnect).toBeNull();
    expect(publicConfig(config, null).disconnect).toBeNull();
  });
}
