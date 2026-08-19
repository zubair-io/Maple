/**
 * The loop's `generateJson` dependency: one grammar-constrained Ollama call
 * returning parsed JSON.
 *
 * The `thinking` fallback is not defensive padding — it is a live failure
 * this repo already hit (#2172). Under a `format` schema constraint the
 * grammar prevents a thinking model from emitting its `</think>` terminator,
 * so Ollama's template parser classifies the ENTIRE constrained output as
 * `thinking` and returns `response: ""` with `done_reason: stop`. Confirmed
 * per-model while probing this feature: `ornith:35b` routes through
 * `thinking`, `gemma4:12b` through `response`. Reading only `response` would
 * make the worker silently produce nothing on half the available models.
 */

import { child as childLogger } from '../../log.ts';

const log = childLogger('generated-search:ollama');

/** Text generation is slower than the describe stage's per-image call — the
 * proposal prompt is long and thinking models spend tokens before emitting. */
const REQUEST_TIMEOUT_MS = 180_000;

export interface OllamaJsonClient {
  generateJson(prompt: string, schema: unknown): Promise<unknown>;
}

/** Just the slice of `fetch` this adapter uses. Narrower than `typeof fetch`
 * on purpose: the full signature carries overloads a test stub cannot
 * satisfy, and widening the stubs with casts would hide real mismatches. */
export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

interface GenerateBody {
  response?: unknown;
  thinking?: unknown;
}

/** Pull the generated text out of a `/api/generate` body, tolerating the
 * thinking-misroute described above. */
export function extractJsonText(body: GenerateBody): string | undefined {
  const response = typeof body.response === 'string' ? body.response.trim() : '';
  if (response.length > 0) return response;
  const thinking = typeof body.thinking === 'string' ? body.thinking.trim() : '';
  return thinking.length > 0 ? thinking : undefined;
}

export function createOllamaJsonClient(
  baseUrl: string,
  model: string,
  fetchImpl: FetchLike = fetch,
): OllamaJsonClient {
  const url = `${baseUrl.replace(/\/+$/, '')}/api/generate`;

  return {
    async generateJson(prompt: string, schema: unknown): Promise<unknown> {
      const res = await fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model, prompt, stream: false, format: schema }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (!res.ok) {
        throw new Error(`Ollama /api/generate returned ${res.status}`);
      }

      const body = (await res.json()) as GenerateBody;
      const text = extractJsonText(body);
      if (text === undefined) {
        throw new Error('Ollama returned neither response nor thinking text');
      }
      if (typeof body.response !== 'string' || body.response.trim().length === 0) {
        log.debug({ model }, 'recovered constrained JSON from the thinking field (#2172)');
      }

      try {
        return JSON.parse(text);
      } catch {
        // The grammar constraint should make this unreachable on Ollama 0.5+,
        // but older builds ignore `format` entirely.
        throw new Error('Ollama returned text that is not valid JSON');
      }
    },
  };
}
