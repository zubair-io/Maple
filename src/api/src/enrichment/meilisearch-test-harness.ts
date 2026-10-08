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

export interface FakeMeilisearchIndex {
  fetchImpl: typeof fetch;
  patches: Array<Record<string, unknown>>;
  requests: string[];
}

export interface FakeMeilisearchIndexOptions {
  documents?: number;
  pendingTaskUid?: number;
  failSettings?: boolean;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

type Settings = Record<string, unknown>;

function withoutNulls(fields: Settings): Settings {
  return Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== null));
}

/** Meilisearch merges a partial embedder object into the stored one; a
 * `null` embedder removes it and a `null` field resets that field. */
function mergeEmbedders(current: unknown, patch: unknown): unknown {
  if (patch === null) return {};
  const stored = (current ?? {}) as Record<string, Settings>;
  const merged = Object.entries(patch as Record<string, Settings | null>).map(
    ([name, fields]) =>
      [name, fields === null ? null : withoutNulls({ ...stored[name], ...fields })] as const,
  );
  return withoutNulls({ ...stored, ...Object.fromEntries(merged) });
}

/** A stateful stand-in for one Meilisearch `assets` index: GET /settings
 * returns what was last applied, PATCH merges like Meilisearch does, and every
 * task succeeds at once. */
export function fakeMeilisearchIndex(
  initial: Settings,
  options: FakeMeilisearchIndexOptions = {},
): FakeMeilisearchIndex {
  const settings: Settings = structuredClone(initial);
  const patches: Settings[] = [];
  const requests: string[] = [];
  const pending = options.pendingTaskUid;
  const settingsRoute = (method: string, body: unknown): Response => {
    if (options.failSettings) return jsonResponse({ message: 'internal' }, 500);
    if (method === 'GET') return jsonResponse(settings);
    const patch = JSON.parse(String(body)) as Settings;
    patches.push(patch);
    const { embedders, ...attributes } = patch;
    Object.assign(settings, attributes);
    if ('embedders' in patch) settings.embedders = mergeEmbedders(settings.embedders, embedders);
    return jsonResponse({ taskUid: 41 }, 202);
  };
  const routes: Record<string, (method: string, body: unknown) => Response> = {
    '/health': () => jsonResponse({ status: 'available' }),
    '/indexes': () => jsonResponse({ code: 'index_already_exists' }, 409),
    '/tasks': () => jsonResponse({ results: pending === undefined ? [] : [{ uid: pending }] }),
    '/indexes/assets/settings': settingsRoute,
    '/indexes/assets/stats': () =>
      jsonResponse({ numberOfDocuments: options.documents ?? 0, isIndexing: false }),
    '/indexes/assets/search': () => jsonResponse({ hits: [{ id: 'a1' }], estimatedTotalHits: 1 }),
  };
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input.toString());
    const method = init?.method ?? 'GET';
    requests.push(`${method} ${url.pathname}${url.search}`);
    const taskUid = url.pathname.startsWith('/tasks/') ? Number(url.pathname.slice(7)) : null;
    if (taskUid !== null) return jsonResponse({ uid: taskUid, status: 'succeeded' });
    return routes[url.pathname]?.(method, init?.body) ?? jsonResponse({});
  }) as unknown as typeof fetch;
  return { fetchImpl, patches, requests };
}
