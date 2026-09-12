/**
 * Truncated-generation handling for OllamaProvider (#3561).
 *
 * Split from `ollama.test.ts` for the LOC budget; the fetch mock is shared
 * via `ollama.test-helpers.ts`.
 */

import { describe, it, expect } from 'bun:test';
import { OllamaProvider } from './ollama.ts';
import type { RemoteError } from './index.ts';
import { mockFetch } from './ollama.test-helpers.ts';

describe('OllamaProvider truncated generations (#3561)', () => {
  // Output is grammar-constrained by `format`, so the model cannot emit
  // malformed JSON — a cut-off body always means generation stopped early.
  // Ollama says so in the envelope; the provider must not pass the fragment
  // down to the strict parser, where it surfaces as an opaque `not-json`.
  const TRUNCATED = '{"is_screenshot": false, "people_count": 0, "caption": "A wide nighttime v';

  it('rejects a `done_reason: length` generation as retryable', async () => {
    const { fetchImpl } = mockFetch([
      {
        status: 200,
        body: {
          model: 'gemma4:12b',
          response: TRUNCATED,
          done: true,
          done_reason: 'length',
          eval_count: 2048,
        },
      },
    ]);
    const provider = new OllamaProvider({ baseUrl: 'http://ollama.test', fetchImpl });
    let caught: RemoteError | null = null;
    try {
      await provider.describe([Buffer.alloc(4)], { systemPrompt: 'p', model: 'gemma4:12b' });
    } catch (e) {
      caught = e as RemoteError;
    }
    expect(caught).toBeTruthy();
    expect(caught!.retryable).toBe(true);
  });

  it('names the truncation and its provider state in the error message', async () => {
    const { fetchImpl } = mockFetch([
      {
        status: 200,
        body: {
          model: 'gemma4:12b',
          response: TRUNCATED,
          done: true,
          done_reason: 'length',
          eval_count: 2048,
          total_duration: 7_000_000_000,
        },
      },
    ]);
    const provider = new OllamaProvider({ baseUrl: 'http://ollama.test', fetchImpl });
    let caught: RemoteError | null = null;
    try {
      await provider.describe([Buffer.alloc(4)], {
        systemPrompt: 'secret prompt content',
        model: 'gemma4:12b',
      });
    } catch (e) {
      caught = e as RemoteError;
    }
    expect(caught).toBeTruthy();
    expect(caught!.message).toContain('stopped generating before it finished');
    expect(caught!.message).toContain('model=gemma4:12b');
    expect(caught!.message).toContain('done_reason=length');
    expect(caught!.message).toContain('eval_count=2048');
    // Same contract as the empty-response diagnostics: no prompt content.
    expect(caught!.message).not.toContain('secret prompt content');
    expect(caught!.status).toBe(200);
  });

  it('rejects an unfinished generation (`done: false`) as retryable', async () => {
    const { fetchImpl } = mockFetch([
      { status: 200, body: { model: 'gemma4:12b', response: TRUNCATED, done: false } },
    ]);
    const provider = new OllamaProvider({ baseUrl: 'http://ollama.test', fetchImpl });
    let caught: RemoteError | null = null;
    try {
      await provider.describe([Buffer.alloc(4)], { systemPrompt: 'p', model: 'gemma4:12b' });
    } catch (e) {
      caught = e as RemoteError;
    }
    expect(caught).toBeTruthy();
    expect(caught!.retryable).toBe(true);
    expect(caught!.message).toContain('done=false');
  });

  it('recovers when a truncated generation is followed by a complete one', async () => {
    const complete = '{"is_screenshot":false,"caption":"a complete answer"}';
    const { fetchImpl } = mockFetch([
      { status: 200, body: { response: TRUNCATED, done: true, done_reason: 'length' } },
      {
        status: 200,
        body: { model: 'gemma4:12b', response: complete, done: true, done_reason: 'stop' },
      },
    ]);
    const provider = new OllamaProvider({ baseUrl: 'http://ollama.test', fetchImpl });
    await expect(
      provider.describe([Buffer.alloc(4)], { systemPrompt: 'p', model: 'gemma4:12b' }),
    ).rejects.toThrow(/stopped generating/);
    const result = await provider.describe([Buffer.alloc(4)], {
      systemPrompt: 'p',
      model: 'gemma4:12b',
    });
    expect(result.text).toBe(complete);
  });

  it('passes a normal `done_reason: stop` generation straight through', async () => {
    const complete = '{"is_screenshot":false,"caption":"tree bark with lichen"}';
    const { fetchImpl } = mockFetch([
      {
        status: 200,
        body: { model: 'gemma4:12b', response: complete, done: true, done_reason: 'stop' },
      },
    ]);
    const provider = new OllamaProvider({ baseUrl: 'http://ollama.test', fetchImpl });
    const result = await provider.describe([Buffer.alloc(4)], {
      systemPrompt: 'p',
      model: 'gemma4:12b',
    });
    expect(result.text).toBe(complete);
  });

  it('passes a generation through when the build omits done_reason', async () => {
    // Older Ollama builds don't send `done_reason`. Absence must not be read
    // as truncation, or every such deploy fails every describe.
    const complete = '{"is_screenshot":false,"caption":"no done_reason here"}';
    const { fetchImpl } = mockFetch([
      { status: 200, body: { model: 'gemma4:12b', response: complete, done: true } },
    ]);
    const provider = new OllamaProvider({ baseUrl: 'http://ollama.test', fetchImpl });
    const result = await provider.describe([Buffer.alloc(4)], {
      systemPrompt: 'p',
      model: 'gemma4:12b',
    });
    expect(result.text).toBe(complete);
  });
});
