/**
 * The loop's `generateJson` dependency for an OpenAI or OpenAI-compatible
 * connection: one `/chat/completions` call constrained by
 * `response_format: json_schema`, returning parsed JSON.
 *
 * The schema is sent without `strict`: strict mode requires
 * `additionalProperties: false` everywhere and rejects keywords the loop's
 * schemas use, and `validate.ts` is the real boundary either way. Servers that
 * do not enforce the schema may wrap the object in a code fence, and
 * reasoning parsers (vLLM, llama.cpp) can route the whole constrained output
 * into `reasoning_content` — the same misroute Ollama has with `thinking`
 * (#2172) — so both are tolerated.
 */

import { openAiBaseUrl } from '../../enrichment/describe-providers/openai.ts';
import { stripFences } from '../../enrichment/describe-providers/parse-vision-json-errors.ts';
import type { FetchLike, JsonClient } from './json-client.ts';

const REQUEST_TIMEOUT_MS = 180_000;
const ERROR_DETAIL_CHARS = 300;

interface ChatMessage {
  content?: unknown;
  reasoning_content?: unknown;
  reasoning?: unknown;
}

interface ChatBody {
  choices?: Array<{ message?: ChatMessage; finish_reason?: unknown }>;
}

const nonEmpty = (value: unknown): string | undefined => {
  const text = typeof value === 'string' ? value.trim() : '';
  return text.length > 0 ? text : undefined;
};

export function chatJsonText(body: ChatBody): string | undefined {
  const message = body.choices?.[0]?.message;
  const text =
    nonEmpty(message?.content) ??
    nonEmpty(message?.reasoning_content) ??
    nonEmpty(message?.reasoning);
  return text === undefined ? undefined : stripFences(text).trim();
}

async function failure(res: Response): Promise<Error> {
  const detail = (await res.text().catch(() => '')).trim().slice(0, ERROR_DETAIL_CHARS);
  return new Error(
    `OpenAI-compatible /chat/completions returned ${res.status}${detail ? `: ${detail}` : ''}`,
  );
}

export function createOpenAiJsonClient(
  baseUrl: string,
  apiKey: string | null | undefined,
  model: string,
  fetchImpl: FetchLike = fetch,
): JsonClient {
  const key = apiKey?.trim();
  if (!key) throw new Error('generated search: the OpenAI connection has no API key');
  const url = `${openAiBaseUrl(baseUrl)}/chat/completions`;

  return {
    async generateJson(prompt: string, schema: unknown): Promise<unknown> {
      const res = await fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
        body: JSON.stringify({
          model,
          messages: [{ role: 'user', content: prompt }],
          response_format: { type: 'json_schema', json_schema: { name: 'response', schema } },
        }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (!res.ok) throw await failure(res);
      const body = (await res.json()) as ChatBody;
      if (body.choices?.[0]?.finish_reason === 'length') {
        throw new Error('OpenAI-compatible server truncated the answer at its output limit');
      }
      const text = chatJsonText(body);
      if (text === undefined) {
        throw new Error('OpenAI-compatible server returned no message content');
      }
      try {
        return JSON.parse(text);
      } catch {
        throw new Error('OpenAI-compatible server returned text that is not valid JSON');
      }
    },
  };
}
