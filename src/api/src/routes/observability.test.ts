/**
 * routes/observability.ts — access control and secret handling (#4744).
 *
 * The saved SigNoz ingestion key is an operator secret. Only the owner may
 * change where telemetry goes or run a probe, and a probe may only carry the
 * saved key to the endpoint it was saved for — never to a caller-chosen URL.
 */

import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { Elysia } from 'elysia';
import { observabilityRoutes } from './observability.ts';
import { fakeAuth } from '../../tests/helpers/test-auth.ts';
import {
  createLiveTestDatabase,
  type LiveTestDatabase,
} from '../db/sqlite/test-sqlite.test-helpers.ts';
import {
  loadObservabilityConfig,
  saveObservabilityConfig,
} from '../observability/observability-config.repo.ts';

const SAVED_ENDPOINT = 'http://signoz.internal:4318';
const SAVED_KEY = 'saved-ingestion-key';

let live: LiveTestDatabase;

beforeEach(async () => {
  live = await createLiveTestDatabase();
  await saveObservabilityConfig({
    endpoint: SAVED_ENDPOINT,
    ingestion_key: SAVED_KEY,
    ingestion_key_endpoint: SAVED_ENDPOINT,
  });
});

afterEach(() => {
  live.close();
});

function appAs(role: 'owner' | 'member') {
  return new Elysia().use(fakeAuth({ role })).use(observabilityRoutes);
}

function json(method: string, path: string, body: unknown): Request {
  return new Request(`http://localhost/api/observability${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/** Replace `fetch` for one probe and return the headers the probe sent. */
async function probeHeaders(role: 'owner' | 'member', body: unknown) {
  let sent: Headers | null = null;
  const fakeFetch = Object.assign(
    async (_input: URL | RequestInfo, init?: RequestInit) => {
      sent = new Headers(init?.headers);
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    },
    { preconnect: globalThis.fetch.preconnect },
  );
  const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(fakeFetch);
  try {
    const res = await appAs(role).handle(json('POST', '/test', body));
    return { res, sent: sent as Headers | null, calls: fetchSpy.mock.calls.length };
  } finally {
    fetchSpy.mockRestore();
  }
}

describe('owner gate (#4744)', () => {
  it('members can still read the public config', async () => {
    const res = await appAs('member').handle(
      new Request('http://localhost/api/observability/config'),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.ingestion_key).toBeUndefined();
    expect(body.ingestion_key_set).toBe(true);
  });

  it('refuses a member PUT /config with 403 and keeps the saved endpoint', async () => {
    const res = await appAs('member').handle(
      json('PUT', '/config', { endpoint: 'http://attacker.example:4318' }),
    );
    expect(res.status).toBe(403);
    expect((await loadObservabilityConfig())?.endpoint).toBe(SAVED_ENDPOINT);
  });

  it('refuses a member POST /test with 403 without contacting the endpoint', async () => {
    const { res, calls } = await probeHeaders('member', {
      endpoint: 'http://attacker.example:4318',
    });
    expect(res.status).toBe(403);
    expect(calls).toBe(0);
  });
});

describe('saved key never leaves for a foreign endpoint (#4744)', () => {
  it('omits the saved key when the probe targets a different endpoint', async () => {
    const { res, sent } = await probeHeaders('owner', {
      endpoint: 'http://elsewhere.example:4318',
    });
    expect(res.status).toBe(200);
    expect(sent?.get('signoz-access-token')).toBeNull();
  });

  it('attaches the saved key when the probe targets the saved endpoint', async () => {
    const { sent } = await probeHeaders('owner', { endpoint: `${SAVED_ENDPOINT}/` });
    expect(sent?.get('signoz-access-token')).toBe(SAVED_KEY);
  });

  it('changing the endpoint without a new key leaves the key unusable for it', async () => {
    const res = await appAs('owner').handle(
      json('PUT', '/config', { endpoint: 'http://replacement.example:4318', enabled: false }),
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as { ingestion_key_set: boolean }).ingestion_key_set).toBe(false);
    const { sent } = await probeHeaders('owner', { endpoint: 'http://replacement.example:4318' });
    expect(sent?.get('signoz-access-token')).toBeNull();
  });

  it('a key saved with endpoint B never follows a stale write of endpoint A', async () => {
    // Two overlapping owner saves: one moves to B with a fresh key, the other
    // (which read endpoint A earlier) re-saves A without a key. Whatever order
    // they land in, the B key must not become usable for A.
    await appAs('owner').handle(
      json('PUT', '/config', {
        endpoint: 'http://replacement.example:4318',
        ingestion_key: 'key-for-b',
        enabled: false,
      }),
    );
    await appAs('owner').handle(
      json('PUT', '/config', { endpoint: SAVED_ENDPOINT, enabled: false }),
    );
    const { sent } = await probeHeaders('owner', { endpoint: SAVED_ENDPOINT });
    expect(sent?.get('signoz-access-token')).toBeNull();
  });

  it('a key saved while the endpoint was blank never follows a later endpoint', async () => {
    await appAs('owner').handle(
      json('PUT', '/config', { endpoint: null, ingestion_key: 'early-key' }),
    );
    await appAs('owner').handle(
      json('PUT', '/config', { endpoint: 'http://later.example:4318', enabled: false }),
    );
    const { sent } = await probeHeaders('owner', { endpoint: 'http://later.example:4318' });
    expect(sent?.get('signoz-access-token')).toBeNull();
  });

  it('a key saved while clearing the endpoint stays bound to no endpoint', async () => {
    await appAs('owner').handle(
      json('PUT', '/config', { endpoint: null, ingestion_key: 'cleared-key' }),
    );
    await appAs('owner').handle(
      json('PUT', '/config', { endpoint: SAVED_ENDPOINT, enabled: false }),
    );
    const { sent } = await probeHeaders('owner', { endpoint: SAVED_ENDPOINT });
    expect(sent?.get('signoz-access-token')).toBeNull();
  });

  it('re-saving a key without an endpoint binds it to the saved endpoint', async () => {
    await appAs('owner').handle(json('PUT', '/config', { ingestion_key: 'rotated-key' }));
    const { sent } = await probeHeaders('owner', { endpoint: SAVED_ENDPOINT });
    expect(sent?.get('signoz-access-token')).toBe('rotated-key');
  });

  it('changing the endpoint together with a new key keeps that key', async () => {
    const res = await appAs('owner').handle(
      json('PUT', '/config', {
        endpoint: 'http://replacement.example:4318',
        ingestion_key: 'replacement-key',
        enabled: false,
      }),
    );
    expect(res.status).toBe(200);
    expect((await loadObservabilityConfig())?.ingestion_key).toBe('replacement-key');
  });

  it('re-saving the same endpoint keeps the saved key', async () => {
    await appAs('owner').handle(
      json('PUT', '/config', { endpoint: `${SAVED_ENDPOINT}/`, enabled: false }),
    );
    expect((await loadObservabilityConfig())?.ingestion_key).toBe(SAVED_KEY);
  });

  it('a typed key is sent as given, whatever the endpoint', async () => {
    const { sent } = await probeHeaders('owner', {
      endpoint: 'http://elsewhere.example:4318',
      ingestion_key: 'typed-key',
    });
    expect(sent?.get('signoz-access-token')).toBe('typed-key');
  });
});
