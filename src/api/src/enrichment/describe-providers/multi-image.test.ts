import { describe, expect, it } from 'bun:test';
import { GeminiProvider } from './gemini.ts';
import { OpenAIProvider } from './openai.ts';

function recordingFetch(responseBody: unknown): {
  calls: RequestInit[];
  fetchImpl: typeof fetch;
} {
  const calls: RequestInit[] = [];
  const fetchImpl = (async (_input: string | URL | Request, init?: RequestInit) => {
    calls.push(init ?? {});
    return new Response(JSON.stringify(responseBody), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

const frames = [Buffer.from('first'), Buffer.from('second')];

describe('paid providers — multi-image request shape', () => {
  it('sends ordered image_url parts to OpenAI', async () => {
    const { calls, fetchImpl } = recordingFetch({
      choices: [{ message: { content: 'A scene changes.' } }],
    });
    const provider = new OpenAIProvider({ apiKey: 'test-key', fetchImpl });

    await provider.describe(frames, {
      systemPrompt: 'summarize',
      model: 'gpt-4o-mini',
    });

    const content = JSON.parse(String(calls[0]!.body)).messages[0].content;
    expect(content[0]).toEqual({ type: 'text', text: 'summarize' });
    expect(
      content.slice(1).map((part: { image_url: { url: string } }) => part.image_url.url),
    ).toEqual(frames.map((frame) => `data:image/jpeg;base64,${frame.toString('base64')}`));
  });

  it('rejects empty OpenAI frames before making a request', async () => {
    const { calls, fetchImpl } = recordingFetch({});
    const provider = new OpenAIProvider({ apiKey: 'test-key', fetchImpl });

    await expect(
      provider.describe([], {
        systemPrompt: 'summarize',
        model: 'gpt-4o-mini',
      }),
    ).rejects.toThrow('at least one JPEG frame');
    expect(calls).toHaveLength(0);
  });

  it('sends ordered inline_data parts to Gemini', async () => {
    const { calls, fetchImpl } = recordingFetch({
      candidates: [{ content: { parts: [{ text: 'A scene changes.' }] } }],
    });
    const provider = new GeminiProvider({ apiKey: 'test-key', fetchImpl });

    await provider.describe(frames, {
      systemPrompt: 'summarize',
      model: 'gemini-2.0-flash',
    });

    const parts = JSON.parse(String(calls[0]!.body)).contents[0].parts;
    expect(
      parts.slice(0, 2).map((part: { inline_data: { data: string } }) => part.inline_data.data),
    ).toEqual(frames.map((frame) => frame.toString('base64')));
    expect(parts[2]).toEqual({ text: 'summarize' });
  });

  it('rejects empty Gemini frames before making a request', async () => {
    const { calls, fetchImpl } = recordingFetch({});
    const provider = new GeminiProvider({ apiKey: 'test-key', fetchImpl });

    await expect(
      provider.describe([], {
        systemPrompt: 'summarize',
        model: 'gemini-2.0-flash',
      }),
    ).rejects.toThrow('at least one JPEG frame');
    expect(calls).toHaveLength(0);
  });
});
