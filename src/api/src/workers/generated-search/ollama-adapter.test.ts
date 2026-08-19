/**
 * Unit tests for the Ollama adapter, with `fetch` injected.
 *
 * The thinking-fallback tests cover a live failure (#2172), not a
 * hypothetical: under a `format` schema constraint the grammar prevents a
 * thinking model from emitting `</think>`, so Ollama classifies the whole
 * constrained output as `thinking` and returns an empty `response`. Observed
 * per-model while probing this feature — `ornith:35b` routes through
 * `thinking`, `gemma4:12b` through `response`. Reading only `response` would
 * make the worker silently produce nothing on half the available models.
 */

import { describe, it, expect } from 'bun:test';
import { createOllamaJsonClient, extractJsonText } from './ollama-adapter.ts';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('extractJsonText', () => {
  it('prefers the response field', () => {
    expect(extractJsonText({ response: '{"a":1}', thinking: 'noise' })).toBe('{"a":1}');
  });

  it('falls back to thinking when response is empty (#2172)', () => {
    expect(extractJsonText({ response: '', thinking: '{"a":1}' })).toBe('{"a":1}');
  });

  it('falls back to thinking when response is absent entirely', () => {
    expect(extractJsonText({ thinking: '{"a":1}' })).toBe('{"a":1}');
  });

  it('reports nothing usable when both are empty', () => {
    expect(extractJsonText({ response: '   ', thinking: '' })).toBeUndefined();
  });
});

describe('createOllamaJsonClient', () => {
  it('parses a normal response', async () => {
    const client = createOllamaJsonClient('http://x:11434', 'm', async () =>
      jsonResponse({ response: '{"collections":[]}' }),
    );
    expect(await client.generateJson('p', {})).toEqual({ collections: [] });
  });

  it('recovers JSON routed through thinking', async () => {
    const client = createOllamaJsonClient('http://x:11434', 'm', async () =>
      jsonResponse({ response: '', thinking: '{"collections":[{"theme":"t"}]}' }),
    );
    expect(await client.generateJson('p', {})).toEqual({ collections: [{ theme: 't' }] });
  });

  it('sends the schema as the format constraint', async () => {
    let sent: Record<string, unknown> = {};
    const client = createOllamaJsonClient('http://x:11434', 'm', async (_url, init) => {
      sent = JSON.parse(String(init.body));
      return jsonResponse({ response: '{}' });
    });
    await client.generateJson('the prompt', { type: 'object' });

    expect(sent.format).toEqual({ type: 'object' });
    expect(sent.model).toBe('m');
    expect(sent.prompt).toBe('the prompt');
    expect(sent.stream).toBe(false);
  });

  it('tolerates a trailing slash on the base URL', async () => {
    let calledUrl = '';
    const client = createOllamaJsonClient('http://x:11434/', 'm', async (url) => {
      calledUrl = String(url);
      return jsonResponse({ response: '{}' });
    });
    await client.generateJson('p', {});
    expect(calledUrl).toBe('http://x:11434/api/generate');
  });

  it('throws on a non-2xx so the loop can skip the round', async () => {
    const client = createOllamaJsonClient('http://x:11434', 'm', async () =>
      jsonResponse({ error: 'nope' }, 500),
    );
    await expect(client.generateJson('p', {})).rejects.toThrow('500');
  });

  it('throws when the model returns nothing at all', async () => {
    const client = createOllamaJsonClient('http://x:11434', 'm', async () =>
      jsonResponse({ response: '', thinking: '' }),
    );
    await expect(client.generateJson('p', {})).rejects.toThrow('neither response nor thinking');
  });

  it('throws when the text is not valid JSON', async () => {
    const client = createOllamaJsonClient('http://x:11434', 'm', async () =>
      jsonResponse({ response: 'I think the answer is...' }),
    );
    await expect(client.generateJson('p', {})).rejects.toThrow('not valid JSON');
  });
});
