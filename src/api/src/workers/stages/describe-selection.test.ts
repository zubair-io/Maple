import { describe, expect, it } from 'bun:test';
import { legacyChoice, providerApiKey } from './describe.ts';

const cfg = {
  describe_provider: 'ollama',
  describe_model: 'cfg-model',
  openai_api_key: 'o',
  anthropic_api_key: 'a',
  gemini_api_key: null,
} as never;

describe('providerApiKey', () => {
  it('returns the key of a cloud provider and null otherwise', () => {
    expect(providerApiKey('openai', cfg)).toBe('o');
    expect(providerApiKey('anthropic', cfg)).toBe('a');
    expect(providerApiKey('gemini', cfg)).toBeNull();
    expect(providerApiKey('ollama', cfg)).toBeNull();
  });
});

describe('legacyChoice', () => {
  it('prefers the worker selection over the shared config', () => {
    expect(
      legacyChoice(cfg, { ai_provider: 'openai', ai_model: 'w-model', concurrency: 5 }),
    ).toEqual({ provider: 'openai', model: 'w-model', concurrency: 5 });
  });

  it('falls back to the shared config and a concurrency of 2', () => {
    expect(legacyChoice(cfg, null)).toEqual({
      provider: 'ollama',
      model: 'cfg-model',
      concurrency: 2,
    });
  });
});
