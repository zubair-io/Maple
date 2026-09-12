/**
 * Shared fetch mock for the OllamaProvider suites.
 *
 * Lives outside `ollama.test.ts` so the truncation suite (#3561) can reuse
 * it rather than copy it — the tests split across files for the LOC budget,
 * and a duplicated mock would drift between them.
 */

export interface MockResponse {
  status?: number;
  body?: unknown;
  delayMs?: number;
  failWith?: Error;
}

export function mockFetch(responses: MockResponse[]): {
  fetchImpl: typeof fetch;
  calls: Array<{ url: string; init?: RequestInit }>;
} {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  let i = 0;
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    calls.push({ url, init });
    const r = responses[Math.min(i++, responses.length - 1)]!;
    if (r.failWith) throw r.failWith;
    if (r.delayMs && r.delayMs > 0) {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, r.delayMs);
        if (init?.signal) {
          if (init.signal.aborted) {
            clearTimeout(timer);
            reject(new DOMException('aborted', 'AbortError'));
          } else {
            init.signal.addEventListener('abort', () => {
              clearTimeout(timer);
              reject(new DOMException('aborted', 'AbortError'));
            });
          }
        }
      });
    }
    return new Response(JSON.stringify(r.body ?? {}), {
      status: r.status ?? 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}
