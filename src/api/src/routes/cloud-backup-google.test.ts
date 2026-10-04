import { expect, test } from 'bun:test';
import { Elysia } from 'elysia';
import { signAccessToken } from '../auth/tokens.ts';
import { createLiveTestDatabase } from '../db/sqlite/test-sqlite.test-helpers.ts';
import { buildGoogleBackupRoutes } from './cloud-backup-google.ts';
import { GOOGLE_BACKUP_DDL, saveConfig } from '../cloud-backup/google/repo.ts';
import { insertUser } from '../db/repos/auth.users.repo.ts';
import { DEFAULT_GOOGLE_CONFIG, DRIVE_SCOPE } from '../cloud-backup/google/config.ts';
import type { GoogleFetch } from '../cloud-backup/google/oauth.ts';

const destinationId = 'e9aa2f31-ccdd-4e77-9999-0619988bac3c';
const origin = 'https://photos.example.com';
const secret = 'google-route-test-secret-must-be-long';
function routes(transport?: GoogleFetch) {
  const { owner, callback } = buildGoogleBackupRoutes({
    origin: async () => origin,
    destination: async () => ({ kind: 'google-drive', rootId: null, generation: 0 }),
    attachRoot: async () => {},
    connectionChanged: async () => {},
    transport,
  });
  return new Elysia().use(new Elysia({ name: 'isolatedGoogleOwner' }).use(owner)).use(callback);
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

test('TLS terminating proxy uses bound browser origin and callback cookie without trusting forwarded headers', async () => {
  using db = await createLiveTestDatabase();
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
    const app = routes(async (url) => {
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
        },
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
test('public projection and write-only saved secret never echo credentials', async () => {
  using db = await createLiveTestDatabase();
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
      mapleClientAvailable: false,
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
