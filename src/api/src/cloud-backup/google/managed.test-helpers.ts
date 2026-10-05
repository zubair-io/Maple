import { createLiveTestDatabase, insertFolder } from '../../db/sqlite/test-sqlite.test-helpers.ts';
import { insertUser } from '../../db/repos/auth.users.repo.ts';
import { BackupRepository } from '../repository.ts';
import { DRIVE_SCOPE, RELAY_CALLBACK, RELAY_ORIGIN } from './config.ts';
import type { GoogleFetch } from './oauth.ts';

export const managedId = '12345-maple.apps.googleusercontent.com';
export async function managedFixture(storage: 'memory' | 'file' = 'memory') {
  const live = await createLiveTestDatabase(storage);
  const owner = await insertUser({
    email: 'managed-owner@example.com',
    role: 'owner',
    created_at: new Date().toISOString(),
    last_seen_at: null,
  });
  const repo = new BackupRepository();
  const destination = await repo.createDestination({
    libraryId: insertFolder(live.db),
    kind: 'google-drive',
    name: 'Drive',
    path: null,
  });
  return { live, owner: owner.toHexString(), destination, repo };
}
export function managedServer() {
  const requests: Array<{ url: string; init: RequestInit }> = [];
  const controls = {
    metadata: {
      clientId: managedId,
      redirectUri: RELAY_CALLBACK,
      scope: DRIVE_SCOPE,
      available: true,
    },
    metadataStatus: 200,
    scope: DRIVE_SCOPE,
    audience: managedId,
    accountId: 'managed-account',
    exchange: {
      access_token: 'exchange-access',
      refresh_token: 'exchange-refresh',
      relayGrant: 'exchange-grant',
      token_type: 'Bearer',
      expires_in: 30,
    } as Record<string, unknown>,
    renewal: {
      access_token: 'renewal-access',
      refresh_token: 'rotated-refresh',
      relayGrant: 'rotated-grant',
      token_type: 'Bearer',
      expires_in: 30,
    } as Record<string, unknown>,
    exchangeStatus: 200,
    renewalStatus: 200,
    beforeMetadata: async () => {},
    beforeStart: async () => {},
    beforeExchange: async () => {},
    beforeRefresh: async () => {},
  };
  const broker = `${RELAY_ORIGIN}/api/connect/google-drive`;
  const handlers: Record<string, () => Promise<Response>> = {
    [`${broker}/config`]: async () => {
      await controls.beforeMetadata();
      return Response.json(controls.metadata, { status: controls.metadataStatus });
    },
    [`${broker}/start`]: async () => {
      await controls.beforeStart();
      return Response.json({
        ticket: crypto.randomUUID(),
        expiresAt: Date.now() + 300_000,
        redirectUri: RELAY_CALLBACK,
      });
    },
    [`${broker}/exchange`]: async () => {
      await controls.beforeExchange();
      return Response.json(controls.exchange, { status: controls.exchangeStatus });
    },
    [`${broker}/refresh`]: async () => {
      await controls.beforeRefresh();
      return Response.json(controls.renewal, { status: controls.renewalStatus });
    },
    'https://oauth2.googleapis.com/tokeninfo': async () =>
      Response.json({ aud: controls.audience, scope: controls.scope }),
    'https://www.googleapis.com/drive/v3/about?fields=user(permissionId,emailAddress)': async () =>
      Response.json({
        user: { permissionId: controls.accountId, emailAddress: 'owner@example.com' },
      }),
  };
  const transport: GoogleFetch = async (input, init = {}) => {
    requests.push({ url: input.toString(), init });
    const handler = handlers[input.toString()];
    if (!handler)
      throw new Error('Unexpected endpoint: direct exchange must not receive managed credentials');
    return handler();
  };
  return { requests, controls, transport };
}
export function managedState(authorizationUrl: string): string {
  const encoded = new URL(authorizationUrl).hash.slice(1);
  return (JSON.parse(Buffer.from(encoded, 'base64url').toString()) as { ticket: string }).ticket;
}
