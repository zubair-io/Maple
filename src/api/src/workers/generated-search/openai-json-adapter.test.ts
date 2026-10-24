import { describe, it, expect } from 'bun:test';
import { chatJsonText, createOpenAiJsonClient } from './openai-json-adapter.ts';

function chatResponse(content: unknown, status = 200): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('chatJsonText', () => {
  it('reads the first message and strips one surrounding code fence', () => {
    expect(chatJsonText({ choices: [{ message: { content: ' {"a":1} ' } }] })).toBe('{"a":1}');
    expect(chatJsonText({ choices: [{ message: { content: '```json\n{"a":1}\n```' } }] })).toBe(
      '{"a":1}',
    );
  });

  it('falls back to reasoning_content when a reasoning parser swallows the answer', () => {
    expect(
      chatJsonText({ choices: [{ message: { content: '', reasoning_content: '{"a":1}' } }] }),
    ).toBe('{"a":1}');
  });

  it('reports nothing usable for empty or missing content', () => {
    expect(chatJsonText({ choices: [{ message: { content: '  ' } }] })).toBeUndefined();
    expect(chatJsonText({})).toBeUndefined();
  });
});

describe('createOpenAiJsonClient', () => {
  it('posts a schema-constrained chat completion with the bearer key', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const client = createOpenAiJsonClient(
      'http://strata:8080/v1/',
      'sk-s',
      'qwen',
      async (url, init) => {
        calls.push({ url, init });
        return chatResponse('{"themes":[]}');
      },
    );
    const schema = { type: 'object' };
    expect(await client.generateJson('prompt', schema)).toEqual({ themes: [] });
    expect(calls[0]!.url).toBe('http://strata:8080/v1/chat/completions');
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBe('Bearer sk-s');
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({
      model: 'qwen',
      messages: [{ role: 'user', content: 'prompt' }],
      response_format: { type: 'json_schema', json_schema: { name: 'response', schema } },
    });
  });

  it('uses OpenAI itself when the base URL is blank', async () => {
    const urls: string[] = [];
    const client = createOpenAiJsonClient('', 'k', 'gpt-4o-mini', async (url) => {
      urls.push(url);
      return chatResponse('{}');
    });
    await client.generateJson('p', {});
    expect(urls).toEqual(['https://api.openai.com/v1/chat/completions']);
  });

  it('refuses to build a client without a key', () => {
    expect(() => createOpenAiJsonClient('http://s/v1', ' ', 'm')).toThrow('has no API key');
  });

  it('reports the server error text and output-limit truncation', async () => {
    const answering = (res: Response) =>
      createOpenAiJsonClient('http://s/v1', 'k', 'm', async () => res);
    await expect(
      answering(new Response('{"error":"json_schema unsupported"}', { status: 400 })).generateJson(
        'p',
        {},
      ),
    ).rejects.toThrow('returned 400: {"error":"json_schema unsupported"}');
    const truncated = new Response(
      JSON.stringify({ choices: [{ message: { content: '{"a":' }, finish_reason: 'length' }] }),
    );
    await expect(answering(truncated).generateJson('p', {})).rejects.toThrow('truncated');
  });

  it('rejects a non-OK answer, empty content and non-JSON text', async () => {
    const failing = (res: Response) =>
      createOpenAiJsonClient('http://s/v1', 'k', 'm', async () => res);
    await expect(failing(chatResponse('{}', 401)).generateJson('p', {})).rejects.toThrow(
      'returned 401',
    );
    await expect(failing(chatResponse('')).generateJson('p', {})).rejects.toThrow(
      'no message content',
    );
    await expect(failing(chatResponse('not json')).generateJson('p', {})).rejects.toThrow(
      'not valid JSON',
    );
  });
});
