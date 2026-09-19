/**
 * /api/enrichment/* route tests. Exercises the route directly via
 * `app.handle`. GET/test routes need no auth beyond a bearer (mirroring the
 * search-route + jobs-route patterns); PUT /config additionally requires the
 * `owner` role (#2353) — the `put()` helper below defaults to an owner JWT so
 * the existing save-path tests stay unchanged. Meilisearch-field PUT coverage
 * and the dedicated owner-gate rejection tests live in
 * `enrichment-route-meilisearch.test.ts` (split for the file-size budget).
 *
 * The Nominatim health-check is faked by stubbing `globalThis.fetch` for
 * the duration of each test — no network calls.
 *
 * Storage is SQLite (#3787): the saved config is one row of `app_settings`,
 * and each test gets a private database installed as the process-wide handle,
 * which is what replaces the old per-test `deleteMany`.
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'bun:test';
import { Elysia } from 'elysia';
import { signAccessToken } from '../src/auth/tokens.ts';
import {
  createLiveTestDatabase,
  type LiveTestDatabase,
} from '../src/db/sqlite/test-sqlite.test-helpers.ts';
import { newObjectIdHex } from '../src/db/object-id.ts';
import { withTestEnv } from '../src/test-support/env.test-helpers.ts';
import { readEnrichmentConfig, seedEnrichmentConfig } from './helpers/enrichment-route-fixtures.ts';

process.env.MAPLE_JWT_SECRET = 'x'.repeat(32);

// Keep every worker dormant for the duration of this file: their health-checks
// would otherwise trip the global fetch stub or spawn poll loops. An empty
// Nominatim URL reads as unset, which is what the env-fallback test asserts.
withTestEnv('MAPLE_NOMINATIM_URL', '');
withTestEnv('MAPLE_GEOCODE_WORKER_ENABLED', 'false');
withTestEnv('MAPLE_DESCRIBE_WORKER_ENABLED', 'false');
withTestEnv('MAPLE_FACE_WORKER_ENABLED', 'false');
withTestEnv('MAPLE_OCR_WORKER_ENABLED', 'false');

let live: LiveTestDatabase;
let app: Pick<Elysia, 'handle'> | null = null;

const realFetch = globalThis.fetch;

const ownerJwt = await signAccessToken(
  { file_access: true, sub: newObjectIdHex(), email: 'o@m.c', role: 'owner' },
  'x'.repeat(32),
);
const memberJwt = await signAccessToken(
  { file_access: true, sub: newObjectIdHex(), email: 'm@m.c', role: 'member' },
  'x'.repeat(32),
);

beforeAll(async () => {
  const { enrichmentRoutes } = await import('../src/routes/enrichment.ts');
  app = new Elysia().use(enrichmentRoutes);
});

beforeEach(async () => {
  live = await createLiveTestDatabase();
});

afterEach(() => {
  globalThis.fetch = realFetch;
  live.close();
});

function stubFetch(handler: (url: string) => { status?: number; body?: unknown } | Error): void {
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input.toString();
    const r = handler(url);
    if (r instanceof Error) throw r;
    return new Response(JSON.stringify(r.body ?? {}), { status: r.status ?? 200 });
  }) as typeof fetch;
}

async function get(
  path: string,
  jwt: string = memberJwt,
): Promise<{ status: number; body: unknown }> {
  const res = await app!.handle(
    new Request(`http://localhost${path}`, { headers: { authorization: `Bearer ${jwt}` } }),
  );
  return { status: res.status, body: res.status === 204 ? null : await res.json() };
}

// Defaults to an owner bearer — PUT /config is owner-gated (#2353). Pass
// `jwt` explicitly to exercise the member rejection path; the no-bearer
// (401) path is exercised directly against `app!.handle` below since its
// body isn't JSON.
async function put(
  path: string,
  body: Record<string, unknown>,
  jwt: string = ownerJwt,
): Promise<{ status: number; body: unknown }> {
  const res = await app!.handle(
    new Request(`http://localhost${path}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${jwt}` },
      body: JSON.stringify(body),
    }),
  );
  return { status: res.status, body: res.status === 204 ? null : await res.json() };
}

async function post(
  path: string,
  body: Record<string, unknown>,
  jwt: string = memberJwt,
): Promise<{ status: number; body: unknown }> {
  const res = await app!.handle(
    new Request(`http://localhost${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${jwt}` },
      body: JSON.stringify(body),
    }),
  );
  return { status: res.status, body: res.status === 204 ? null : await res.json() };
}

describe('GET /api/enrichment/config', () => {
  it('returns env fallback when no DB row exists', async () => {
    const r = await get('/api/enrichment/config');
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      nominatim_url: null,
      geocode_worker_enabled: false,
      source: {
        nominatim_url: 'unset',
        geocode_worker_enabled: 'env',
      },
    });
  });

  it('returns the saved DB row when present', async () => {
    seedEnrichmentConfig(live.db, {
      nominatim_url: 'http://from-db.test:8080',
      geocode_worker_enabled: true,
      updated_at: 1,
    });
    const r = await get('/api/enrichment/config');
    expect(r.status).toBe(200);
    expect((r.body as { nominatim_url: string }).nominatim_url).toBe('http://from-db.test:8080');
    expect((r.body as { source: { nominatim_url: string } }).source.nominatim_url).toBe('db');
  });
});

describe('PUT /api/enrichment/config', () => {
  it('rejects malformed URL with 400', async () => {
    const r = await put('/api/enrichment/config', {
      nominatim_url: 'not-a-url',
      geocode_worker_enabled: true,
    });
    expect(r.status).toBe(400);
    expect((r.body as { error: string }).error).toMatch(/Invalid nominatim_url/);
  });

  it('rejects file:// URL', async () => {
    const r = await put('/api/enrichment/config', {
      nominatim_url: 'file:///etc/passwd',
      geocode_worker_enabled: true,
    });
    expect(r.status).toBe(400);
    expect((r.body as { error: string }).error).toMatch(/protocol/i);
  });

  it('returns 502 when health-check fails (worker enabled + URL set)', async () => {
    stubFetch(() => ({ status: 503 }));
    const r = await put('/api/enrichment/config', {
      nominatim_url: 'http://broken.test',
      geocode_worker_enabled: true,
    });
    expect(r.status).toBe(502);
    expect((r.body as { error: string }).error).toMatch(/health check failed/);
    // Nothing was saved.
    expect(readEnrichmentConfig(live.db)).toBeNull();
  });

  it('saves and returns the resolved config on success', async () => {
    stubFetch(() => ({ status: 200 }));
    const r = await put('/api/enrichment/config', {
      nominatim_url: 'http://nominatim.test:8080/',
      geocode_worker_enabled: true,
    });
    expect(r.status).toBe(200);
    const body = r.body as { nominatim_url: string; source: { nominatim_url: string } };
    // Trailing slash is stripped on save.
    expect(body.nominatim_url).toBe('http://nominatim.test:8080');
    expect(body.source.nominatim_url).toBe('db');
    expect(readEnrichmentConfig(live.db)).toMatchObject({
      nominatim_url: 'http://nominatim.test:8080',
    });
  });

  it('saves without health-check when geocode_worker_enabled=false', async () => {
    let fetchCalled = false;
    stubFetch(() => {
      fetchCalled = true;
      return { status: 200 };
    });
    const r = await put('/api/enrichment/config', {
      nominatim_url: 'http://maybe-broken.test',
      geocode_worker_enabled: false,
    });
    expect(r.status).toBe(200);
    expect(fetchCalled).toBe(false);
  });

  it('saves null URL without health-check', async () => {
    let fetchCalled = false;
    stubFetch(() => {
      fetchCalled = true;
      return { status: 200 };
    });
    const r = await put('/api/enrichment/config', {
      nominatim_url: null,
      geocode_worker_enabled: true,
    });
    expect(r.status).toBe(200);
    expect(fetchCalled).toBe(false);
    const body = r.body as { nominatim_url: string | null };
    expect(body.nominatim_url).toBeNull();
  });

  it('rejects rate limit below the minimum', async () => {
    const r = await put('/api/enrichment/config', {
      nominatim_url: null,
      geocode_worker_enabled: false,
      nominatim_rate_limit_per_sec: 0,
    });
    expect(r.status).toBe(400);
    expect((r.body as { error: string }).error).toMatch(/rate_limit/);
  });

  it('rejects rate limit above the maximum', async () => {
    const r = await put('/api/enrichment/config', {
      nominatim_url: null,
      geocode_worker_enabled: false,
      nominatim_rate_limit_per_sec: 1000,
    });
    expect(r.status).toBe(400);
  });

  it('rejects negative rate limit', async () => {
    const r = await put('/api/enrichment/config', {
      nominatim_url: null,
      geocode_worker_enabled: false,
      nominatim_rate_limit_per_sec: -5,
    });
    expect(r.status).toBe(400);
  });

  it('saves and reflects rate limit on a valid value', async () => {
    const r = await put('/api/enrichment/config', {
      nominatim_url: null,
      geocode_worker_enabled: false,
      nominatim_rate_limit_per_sec: 2.5,
    });
    expect(r.status).toBe(200);
    const body = r.body as {
      nominatim_rate_limit_per_sec: number;
      source: { nominatim_rate_limit_per_sec: string };
    };
    expect(body.nominatim_rate_limit_per_sec).toBe(2.5);
    expect(body.source.nominatim_rate_limit_per_sec).toBe('db');
  });

  it('clears rate limit back to default when null is supplied', async () => {
    // Save a value first.
    await put('/api/enrichment/config', {
      nominatim_url: null,
      geocode_worker_enabled: false,
      nominatim_rate_limit_per_sec: 2.5,
    });
    // Then null it out.
    const r = await put('/api/enrichment/config', {
      nominatim_url: null,
      geocode_worker_enabled: false,
      nominatim_rate_limit_per_sec: null,
    });
    expect(r.status).toBe(200);
    const body = r.body as {
      nominatim_rate_limit_per_sec: number;
      source: { nominatim_rate_limit_per_sec: string };
    };
    expect(body.nominatim_rate_limit_per_sec).toBe(10);
    expect(body.source.nominatim_rate_limit_per_sec).toBe('default');
  });
});

describe('PUT /api/enrichment/config — describe servers', () => {
  it('saves the list and mirrors the first entry onto describe_provider_url', async () => {
    const r = await put('/api/enrichment/config', {
      nominatim_url: null,
      geocode_worker_enabled: false,
      describe_servers: [
        { url: 'http://gpu-a:11434/', concurrency: 4 },
        { url: 'http://gpu-b:11434', concurrency: 1 },
      ],
    });
    expect(r.status).toBe(200);
    const body = r.body as {
      describe_servers: Array<{ url: string; concurrency: number }>;
      describe_provider_url: string;
    };
    expect(body.describe_servers).toEqual([
      { url: 'http://gpu-a:11434', concurrency: 4 },
      { url: 'http://gpu-b:11434', concurrency: 1 },
    ]);
    // Every other Ollama consumer reads the single URL field, so the default
    // server has to land there too.
    expect(body.describe_provider_url).toBe('http://gpu-a:11434');
  });

  it('defaults a missing per-server concurrency', async () => {
    const r = await put('/api/enrichment/config', {
      nominatim_url: null,
      geocode_worker_enabled: false,
      describe_servers: [{ url: 'http://gpu-a:11434' }],
    });
    expect(r.status).toBe(200);
    expect((r.body as { describe_servers: unknown }).describe_servers).toEqual([
      { url: 'http://gpu-a:11434', concurrency: 2 },
    ]);
  });

  it('rejects a bad url, a bad concurrency and a duplicate endpoint', async () => {
    for (const servers of [
      [{ url: 'not-a-url' }],
      [{ url: 'http://gpu-a:11434', concurrency: 0 }],
      [{ url: 'http://gpu-a:11434' }, { url: 'http://gpu-a:11434/' }],
    ]) {
      const r = await put('/api/enrichment/config', {
        nominatim_url: null,
        geocode_worker_enabled: false,
        describe_servers: servers,
      });
      expect(r.status).toBe(400);
      expect((r.body as { error: string }).error).toMatch(/Invalid describe_servers/);
    }
    // Nothing was persisted by the rejected writes.
    expect(readEnrichmentConfig(live.db)).toBeNull();
  });

  it('clears back to the single-server fallback on null', async () => {
    await put('/api/enrichment/config', {
      nominatim_url: null,
      geocode_worker_enabled: false,
      describe_servers: [{ url: 'http://gpu-a:11434', concurrency: 4 }],
    });
    const r = await put('/api/enrichment/config', {
      nominatim_url: null,
      geocode_worker_enabled: false,
      describe_servers: null,
      describe_provider_url: 'http://only:11434',
    });
    expect(r.status).toBe(200);
    const body = r.body as { describe_servers: unknown; source: { describe_servers: string } };
    expect(body.describe_servers).toEqual([{ url: 'http://only:11434', concurrency: 2 }]);
    expect(body.source.describe_servers).toBe('derived');
  });
});

describe('GET /api/enrichment/config — rate limit projection', () => {
  it('includes the resolved value + source on a fresh DB', async () => {
    const r = await get('/api/enrichment/config');
    expect(r.status).toBe(200);
    const body = r.body as {
      nominatim_rate_limit_per_sec: number;
      source: { nominatim_rate_limit_per_sec: string };
    };
    expect(body.nominatim_rate_limit_per_sec).toBe(10);
    expect(['env', 'default']).toContain(body.source.nominatim_rate_limit_per_sec);
  });
});

describe('POST /api/enrichment/test', () => {
  it('returns ok:true on successful health-check', async () => {
    stubFetch(() => ({ status: 200 }));
    const r = await post('/api/enrichment/test', {
      nominatim_url: 'http://nominatim.test',
    });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, url: 'http://nominatim.test' });
  });

  it('returns ok:false with detail on 5xx', async () => {
    stubFetch(() => ({ status: 500 }));
    const r = await post('/api/enrichment/test', {
      nominatim_url: 'http://nominatim.test',
    });
    expect(r.status).toBe(200);
    const body = r.body as { ok: boolean; status: number };
    expect(body.ok).toBe(false);
    expect(body.status).toBe(500);
  });

  it('returns 400 for invalid URL', async () => {
    const r = await post('/api/enrichment/test', {
      nominatim_url: 'not-a-url',
    });
    expect(r.status).toBe(400);
  });
});

describe('POST /api/enrichment/test-meili', () => {
  it('returns ok:true when Meilisearch /health is reachable', async () => {
    stubFetch((url) =>
      url.endsWith('/health') ? { status: 200, body: { status: 'available' } } : { status: 200 },
    );
    const r = await post('/api/enrichment/test-meili', {
      meilisearch_url: 'http://meili.test:7700/',
    });
    expect(r.status).toBe(200);
    // Trailing slash is stripped to match the saved/used form.
    expect(r.body).toMatchObject({ ok: true, url: 'http://meili.test:7700' });
  });

  it('returns ok:false when the health check fails', async () => {
    stubFetch(() => ({ status: 503, body: { status: 'unavailable' } }));
    const r = await post('/api/enrichment/test-meili', {
      meilisearch_url: 'http://meili.test:7700',
    });
    expect(r.status).toBe(200);
    expect((r.body as { ok: boolean }).ok).toBe(false);
  });

  it('returns 400 for an invalid URL', async () => {
    const r = await post('/api/enrichment/test-meili', {
      meilisearch_url: 'not-a-url',
    });
    expect(r.status).toBe(400);
  });
});
