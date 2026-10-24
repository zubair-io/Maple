import { describe, it, expect } from 'bun:test';
import { jsonClientFor } from './run.ts';

function recorder() {
  const calls: Array<{ url: string; auth: string | undefined }> = [];
  const fetchImpl = async (url: string, init: RequestInit) => {
    calls.push({ url, auth: (init.headers as Record<string, string>).authorization });
    return new Response(
      JSON.stringify({ response: '{}', choices: [{ message: { content: '{}' } }] }),
    );
  };
  return { calls, fetchImpl };
}

describe('jsonClientFor', () => {
  it('sends an OpenAI connection to its chat completions with its own key', async () => {
    const { calls, fetchImpl } = recorder();
    await jsonClientFor(
      { provider: 'openai', url: 'http://strata:8080/v1', api_key: 'sk-strata' },
      'qwen',
      fetchImpl,
    ).generateJson('p', {});
    expect(calls).toEqual([
      { url: 'http://strata:8080/v1/chat/completions', auth: 'Bearer sk-strata' },
    ]);
  });

  it('keeps an Ollama connection on /api/generate without a key', async () => {
    const { calls, fetchImpl } = recorder();
    await jsonClientFor(
      { provider: 'ollama', url: 'http://gpu:11434' },
      'gemma4:12b',
      fetchImpl,
    ).generateJson('p', {});
    expect(calls).toEqual([{ url: 'http://gpu:11434/api/generate', auth: undefined }]);
  });
});
