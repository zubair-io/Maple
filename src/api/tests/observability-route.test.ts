/**
 * /api/observability/* route tests. Exercises the route directly via
 * `app.handle` (no auth — we mount the route without `requireAuth` for tests,
 * mirroring the enrichment-route + search-route patterns).
 *
 * Real SQLite, installed as the process-wide handle for the length of each
 * test, because the route reaches `sqliteDb()` with no override. A fresh
 * database per test replaces the `deleteMany({})` on `app_settings` the Mongo
 * version ran between tests, and the settings document is both seeded and read
 * back through `app-settings.repo.ts` rather than by hand.
 *
 * The SigNoz `/v1/traces` probe is faked by stubbing `globalThis.fetch` for
 * the duration of each test — no network calls.
 *
 * Config is DB-only (no env fallback), and these tests never save an enabled
 * config with an endpoint (every PUT that writes an endpoint also sets
 * `enabled: false`), so the route's post-save `applyOtelConfig` is always a
 * no-op — no background SDK + batch-exporter timers spin up during the test
 * process. `shutdownOtel` runs in afterAll as belt-and-braces.
 */

import { describe, it, expect, afterAll, afterEach } from 'bun:test';
import { Elysia } from 'elysia';
import { observabilityRoutes } from '../src/routes/observability.ts';
import { patchAppSettings, readAppSettings } from '../src/db/sqlite/repos/app-settings.repo.ts';
import { createLiveTestDatabase } from '../src/db/sqlite/test-sqlite.test-helpers.ts';

const app = new Elysia().use(observabilityRoutes);

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

afterAll(async () => {
  const { shutdownOtel } = await import('../src/otel.ts');
  await shutdownOtel();
});

/** The persisted config document — including the key the wire never echoes. */
async function savedConfig(): Promise<{ ingestion_key?: string | null } | undefined> {
  const doc = await readAppSettings<{ config: { ingestion_key?: string | null } }>('observability');
  return doc?.config;
}

function stubFetch(handler: (url: string) => { status?: number; body?: unknown } | Error): void {
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input.toString();
    const r = handler(url);
    if (r instanceof Error) throw r;
    return new Response(JSON.stringify(r.body ?? {}), {
      status: r.status ?? 200,
    });
  }) as unknown as typeof fetch;
}

async function get(path: string): Promise<{ status: number; body: unknown }> {
  const res = await app.handle(new Request(`http://localhost${path}`));
  return {
    status: res.status,
    body: res.status === 204 ? null : await res.json(),
  };
}

async function put(
  path: string,
  body: Record<string, unknown>,
): Promise<{ status: number; body: unknown }> {
  const res = await app.handle(
    new Request(`http://localhost${path}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
  return {
    status: res.status,
    body: res.status === 204 ? null : await res.json(),
  };
}

async function post(
  path: string,
  body: Record<string, unknown>,
): Promise<{ status: number; body: unknown }> {
  const res = await app.handle(
    new Request(`http://localhost${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
  return {
    status: res.status,
    body: res.status === 204 ? null : await res.json(),
  };
}

describe('GET /api/observability/config', () => {
  it('returns defaults when no DB row exists', async () => {
    using live = await createLiveTestDatabase();
    const r = await get('/api/observability/config');
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      enabled: true, // resolver default (config is DB-only; no row yet)
      endpoint: null,
      service_namespace: 'maple',
      source: { endpoint: 'unset' },
    });
  });

  it('returns the saved DB row but REDACTS the ingestion key', async () => {
    using live = await createLiveTestDatabase();
    await patchAppSettings('observability', {
      config: {
        endpoint: 'https://from-db.test:4318',
        ingestion_key: 'db-secret-key',
        updated_at: 1,
      },
    });
    const r = await get('/api/observability/config');
    expect(r.status).toBe(200);
    const body = r.body as {
      endpoint: string;
      ingestion_key?: string;
      ingestion_key_set: boolean;
      source: { endpoint: string };
    };
    expect(body.endpoint).toBe('https://from-db.test:4318');
    expect(body.source.endpoint).toBe('db');
    // Clients now POST to the /otlp/* proxy (key injected server-side), so the
    // key is NEVER echoed — only the boolean "is a key set" indicator.
    expect(body.ingestion_key).toBeUndefined();
    expect(body.ingestion_key_set).toBe(true);
  });
});

describe('PUT /api/observability/config — endpoint validation', () => {
  it('rejects a malformed endpoint with 400', async () => {
    using live = await createLiveTestDatabase();
    const r = await put('/api/observability/config', { endpoint: 'not-a-url' });
    expect(r.status).toBe(400);
    expect((r.body as { error: string }).error).toMatch(/Invalid endpoint/);
  });

  it('rejects a file:// endpoint with 400', async () => {
    using live = await createLiveTestDatabase();
    const r = await put('/api/observability/config', {
      endpoint: 'file:///etc/passwd',
    });
    expect(r.status).toBe(400);
    expect((r.body as { error: string }).error).toMatch(/protocol/i);
  });

  it('saves and strips the trailing slash, reporting source db', async () => {
    using live = await createLiveTestDatabase();
    const r = await put('/api/observability/config', {
      endpoint: 'https://ingest.signoz.test:4318/',
      enabled: false,
    });
    expect(r.status).toBe(200);
    const body = r.body as { endpoint: string; source: { endpoint: string } };
    expect(body.endpoint).toBe('https://ingest.signoz.test:4318');
    expect(body.source.endpoint).toBe('db');
  });

  it('clears the endpoint when null is supplied', async () => {
    using live = await createLiveTestDatabase();
    await put('/api/observability/config', {
      endpoint: 'https://x.test',
      enabled: false,
    });
    const r = await put('/api/observability/config', { endpoint: null });
    expect(r.status).toBe(200);
    expect((r.body as { endpoint: string | null }).endpoint).toBeNull();
  });
});

describe('PUT /api/observability/config — sample_ratio validation', () => {
  it('rejects a ratio above 1', async () => {
    using live = await createLiveTestDatabase();
    const r = await put('/api/observability/config', { sample_ratio: 1.5 });
    expect(r.status).toBe(400);
    expect((r.body as { error: string }).error).toMatch(/sample_ratio/);
  });

  it('rejects a ratio below 0', async () => {
    using live = await createLiveTestDatabase();
    const r = await put('/api/observability/config', { sample_ratio: -0.1 });
    expect(r.status).toBe(400);
  });

  it('accepts a valid ratio and reflects it with source db', async () => {
    using live = await createLiveTestDatabase();
    const r = await put('/api/observability/config', { sample_ratio: 0.3 });
    expect(r.status).toBe(200);
    const body = r.body as {
      sample_ratio: number;
      source: { sample_ratio: string };
    };
    expect(body.sample_ratio).toBe(0.3);
    expect(body.source.sample_ratio).toBe('db');
  });

  it('accepts the boundary values 0 and 1', async () => {
    using live = await createLiveTestDatabase();
    expect((await put('/api/observability/config', { sample_ratio: 0 })).status).toBe(200);
    expect((await put('/api/observability/config', { sample_ratio: 1 })).status).toBe(200);
  });
});

describe('PUT/GET /api/observability/config — ingestion_key write semantics', () => {
  it('a non-empty string sets the key, persists it, but never echoes it', async () => {
    using live = await createLiveTestDatabase();
    const r = await put('/api/observability/config', {
      ingestion_key: 'set-me',
    });
    expect(r.status).toBe(200);
    // The key value is redacted on the wire (clients use the /otlp/* proxy);
    // only `ingestion_key_set` is reported. `source` still tracks provenance.
    expect((r.body as { ingestion_key?: string }).ingestion_key).toBeUndefined();
    expect((r.body as { ingestion_key_set: boolean }).ingestion_key_set).toBe(true);
    expect((r.body as { source: { ingestion_key: string } }).source.ingestion_key).toBe('db');
    const got = await get('/api/observability/config');
    expect((got.body as { ingestion_key?: string }).ingestion_key).toBeUndefined();
    expect((got.body as { ingestion_key_set: boolean }).ingestion_key_set).toBe(true);
    // Persisted in the DB even though it's never returned.
    expect((await savedConfig())!.ingestion_key).toBe('set-me');
  });

  it('a blank/empty-string key leaves the saved key unchanged', async () => {
    using live = await createLiveTestDatabase();
    await put('/api/observability/config', { ingestion_key: 'keep-me' });
    await put('/api/observability/config', { ingestion_key: '' });
    expect((await savedConfig())!.ingestion_key).toBe('keep-me');
  });

  it('an explicit null clears the saved key', async () => {
    using live = await createLiveTestDatabase();
    await put('/api/observability/config', { ingestion_key: 'delete-me' });
    await put('/api/observability/config', { ingestion_key: null });
    expect((await savedConfig())!.ingestion_key).toBeNull();
  });
});

describe('POST /api/observability/test', () => {
  it('returns ok:true on a 2xx OTLP (application/json) response', async () => {
    using live = await createLiveTestDatabase();
    let calledUrl = '';
    let sawToken = false;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      calledUrl = typeof input === 'string' ? input : input.toString();
      const headers = new Headers(init?.headers);
      sawToken = headers.get('signoz-access-token') === 'probe-key';
      // A real OTLP/HTTP receiver answers JSON.
      return new Response('{}', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;
    const r = await post('/api/observability/test', {
      endpoint: 'https://ingest.signoz.test:4318/',
      ingestion_key: 'probe-key',
    });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, status: 200 });
    // Probes the /v1/traces path on the trailing-slash-stripped base, with the
    // access-token header attached.
    expect(calledUrl).toBe('https://ingest.signoz.test:4318/v1/traces');
    expect(sawToken).toBe(true);
  });

  it('returns ok:false + a :4318 recommendation when a 2xx is HTML (wrong UI port)', async () => {
    using live = await createLiveTestDatabase();
    // SigNoz UI/query port (8080) answers 200 with an HTML SPA page, NOT OTLP.
    globalThis.fetch = (async () =>
      new Response('<!doctype html><html></html>', {
        status: 200,
        headers: { 'content-type': 'text/html' },
      })) as unknown as typeof fetch;
    const r = await post('/api/observability/test', {
      endpoint: 'http://signoz.test:8080',
    });
    expect(r.status).toBe(200);
    const body = r.body as {
      ok: boolean;
      error: string;
      recommendation?: string;
    };
    expect(body.ok).toBe(false);
    expect(body.error).toMatch(/4318/);
    expect(body.recommendation).toMatch(/4318/);
  });

  it('returns ok:false with the status on a non-2xx', async () => {
    using live = await createLiveTestDatabase();
    stubFetch(() => ({ status: 401 }));
    const r = await post('/api/observability/test', {
      endpoint: 'https://ingest.signoz.test:4318',
    });
    expect(r.status).toBe(200);
    const body = r.body as { ok: boolean; status: number };
    expect(body.ok).toBe(false);
    expect(body.status).toBe(401);
  });

  it('flags a 404 on a non-OTLP port with a :4318 recommendation', async () => {
    using live = await createLiveTestDatabase();
    stubFetch(() => ({ status: 404 }));
    const r = await post('/api/observability/test', {
      endpoint: 'http://signoz.test:8080',
    });
    expect(r.status).toBe(200);
    const body = r.body as {
      ok: boolean;
      status: number;
      error: string;
      recommendation?: string;
    };
    expect(body.ok).toBe(false);
    expect(body.status).toBe(404);
    expect(body.error).toMatch(/4318/);
    expect(body.recommendation).toMatch(/4318/);
  });

  it('returns ok:false with an error when the fetch throws', async () => {
    using live = await createLiveTestDatabase();
    stubFetch(() => new Error('ECONNREFUSED'));
    const r = await post('/api/observability/test', {
      endpoint: 'https://unreachable.test:4318',
    });
    expect(r.status).toBe(200);
    const body = r.body as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toMatch(/ECONNREFUSED/);
  });

  it('returns 400 for an invalid endpoint', async () => {
    using live = await createLiveTestDatabase();
    const r = await post('/api/observability/test', { endpoint: 'not-a-url' });
    expect(r.status).toBe(400);
  });
});

describe('POST /api/observability/otlp/v1/:signal — client telemetry proxy', () => {
  /** Seed an enabled DB config so the proxy forwards. Signals default on
   * except metrics; override per test. */
  async function seedConfig(over: Record<string, unknown> = {}): Promise<void> {
    await patchAppSettings('observability', {
      config: {
        enabled: true,
        endpoint: 'https://signoz.test:4318',
        ingestion_key: 'server-key',
        traces_enabled: true,
        logs_enabled: true,
        metrics_enabled: false,
        updated_at: 1,
        ...over,
      },
    });
  }

  /** POST raw bytes (the proxy uses `parse: 'arrayBuffer'`). */
  async function postRaw(
    path: string,
    bytes: Uint8Array,
    contentType = 'application/x-protobuf',
  ): Promise<{ status: number; bodyText: string; res: Response }> {
    const res = await app.handle(
      new Request(`http://localhost${path}`, {
        method: 'POST',
        headers: { 'content-type': contentType },
        // `BodyInit` accepts a BufferSource; the lib DOM type wants an
        // ArrayBuffer-backed view, so hand it the underlying buffer.
        body: bytes.buffer as ArrayBuffer,
      }),
    );
    return { status: res.status, bodyText: await res.clone().text(), res };
  }

  it('forwards the body to ${endpoint}/v1/<signal>, injecting the server key, mirroring status', async () => {
    using live = await createLiveTestDatabase();
    await seedConfig();
    let calledUrl = '';
    let sawToken = false;
    let sawCT = '';
    let fwdBody = new Uint8Array();
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      calledUrl = typeof input === 'string' ? input : input.toString();
      const headers = new Headers(init?.headers);
      sawToken = headers.get('signoz-access-token') === 'server-key';
      sawCT = headers.get('content-type') ?? '';
      fwdBody = new Uint8Array((init?.body as ArrayBuffer | Uint8Array) ?? new Uint8Array());
      return new Response('{"partialSuccess":{}}', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;

    const payload = new Uint8Array([1, 2, 3, 4]);
    const r = await postRaw('/api/observability/otlp/v1/traces', payload);

    expect(r.status).toBe(200);
    expect(calledUrl).toBe('https://signoz.test:4318/v1/traces');
    // The CLIENT never sends the SigNoz key — the proxy injects it server-side.
    expect(sawToken).toBe(true);
    expect(sawCT).toBe('application/x-protobuf');
    // Body forwarded byte-for-byte.
    expect(Array.from(fwdBody)).toEqual([1, 2, 3, 4]);
  });

  it('returns 503 when the requested signal is disabled', async () => {
    using live = await createLiveTestDatabase();
    await seedConfig({ logs_enabled: false });
    let forwarded = false;
    globalThis.fetch = (async () => {
      forwarded = true;
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch;
    const r = await postRaw('/api/observability/otlp/v1/logs', new Uint8Array([0]));
    expect(r.status).toBe(503);
    // Must NOT forward a disabled signal upstream.
    expect(forwarded).toBe(false);
  });

  it('returns 503 when telemetry is disabled entirely', async () => {
    using live = await createLiveTestDatabase();
    await seedConfig({ enabled: false });
    const r = await postRaw('/api/observability/otlp/v1/traces', new Uint8Array([0]));
    expect(r.status).toBe(503);
  });

  it('returns 502 when the upstream forward throws', async () => {
    using live = await createLiveTestDatabase();
    await seedConfig();
    globalThis.fetch = (async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;
    const r = await postRaw('/api/observability/otlp/v1/traces', new Uint8Array([0]));
    expect(r.status).toBe(502);
  });

  it('mirrors a non-2xx upstream status (e.g. 429) so the client retries', async () => {
    using live = await createLiveTestDatabase();
    await seedConfig();
    globalThis.fetch = (async () =>
      new Response('rate limited', { status: 429 })) as unknown as typeof fetch;
    const r = await postRaw('/api/observability/otlp/v1/traces', new Uint8Array([0]));
    expect(r.status).toBe(429);
  });

  it('returns 404 for an unknown signal', async () => {
    using live = await createLiveTestDatabase();
    await seedConfig();
    const r = await postRaw('/api/observability/otlp/v1/bogus', new Uint8Array([0]));
    expect(r.status).toBe(404);
  });
});
