/**
 * Shared test harness for the Meilisearch client suite. No real Meilisearch
 * instance is required — `makeFakeFetch` builds a `fetch` impl that records
 * every call and replies with canned, per-path responses. Lives in its own
 * module (rather than inline in the test) to keep the test file under the
 * per-file LOC budget.
 */

export interface CapturedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

export interface FakeFetchOpts {
  /** Per-path response. The first matching prefix wins. */
  routes?: Array<{
    method: string;
    pathPrefix: string;
    status?: number;
    body?: unknown;
    throwError?: Error;
  }>;
  /** Default response when nothing matches (defaults to 200/{}). */
  defaultStatus?: number;
  defaultBody?: unknown;
}

export function makeFakeFetch(opts: FakeFetchOpts = {}): {
  fetchImpl: typeof fetch;
  calls: CapturedRequest[];
} {
  const calls: CapturedRequest[] = [];
  // The `typeof fetch` declaration in @types/bun (and lib.dom) requires a
  // `preconnect` static method that we don't need; cast through `unknown`
  // so the test fake satisfies the structural call signature.
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const method = init?.method ?? 'GET';
    const headers: Record<string, string> = {};
    const rawHeaders = init?.headers as Record<string, string> | undefined;
    if (rawHeaders) {
      for (const [k, v] of Object.entries(rawHeaders)) headers[k] = v;
    }
    let body: unknown = undefined;
    if (typeof init?.body === 'string') {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    }
    calls.push({ url, method, headers, body });

    const path = new URL(url).pathname;
    for (const r of opts.routes ?? []) {
      if (r.method === method && path.startsWith(r.pathPrefix)) {
        if (r.throwError) throw r.throwError;
        const status = r.status ?? 200;
        return new Response(JSON.stringify(r.body ?? {}), {
          status,
          headers: { 'Content-Type': 'application/json' },
        });
      }
    }
    return new Response(JSON.stringify(opts.defaultBody ?? {}), {
      status: opts.defaultStatus ?? 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}
