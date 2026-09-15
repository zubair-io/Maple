import { describe, expect, it } from 'bun:test';
import {
  resolveEnvKey,
  listProviderModels,
  testProviderConnection,
} from './ai-providers.service.ts';

describe('ai-providers.service', () => {
  describe('resolveEnvKey', () => {
    it('reads MAPLE_<PROVIDER>_API_KEY from process.env', () => {
      const prev = process.env.MAPLE_OPENAI_API_KEY;
      try {
        process.env.MAPLE_OPENAI_API_KEY = 'sk-test-key-123';
        expect(resolveEnvKey('openai')).toBe('sk-test-key-123');
      } finally {
        if (prev === undefined) {
          delete process.env.MAPLE_OPENAI_API_KEY;
        } else {
          process.env.MAPLE_OPENAI_API_KEY = prev;
        }
      }
    });

    it('returns null when env var is unset', () => {
      const prev = process.env.MAPLE_NONEXISTENT_API_KEY;
      try {
        delete process.env.MAPLE_NONEXISTENT_API_KEY;
        expect(resolveEnvKey('nonexistent')).toBeNull();
      } finally {
        if (prev !== undefined) process.env.MAPLE_NONEXISTENT_API_KEY = prev;
      }
    });
  });

  describe('listProviderModels', () => {
    it('returns fallback models when API key is missing for openai', async () => {
      const prev = process.env.MAPLE_OPENAI_API_KEY;
      delete process.env.MAPLE_OPENAI_API_KEY;
      try {
        const res = await listProviderModels('openai');
        expect(res.source).toBe('fallback');
        expect(res.models.length).toBeGreaterThan(0);
        expect(res.models).toContain('gpt-4o');
      } finally {
        if (prev !== undefined) process.env.MAPLE_OPENAI_API_KEY = prev;
      }
    });

    it('returns fallback models when API key is missing for anthropic', async () => {
      const prev = process.env.MAPLE_ANTHROPIC_API_KEY;
      delete process.env.MAPLE_ANTHROPIC_API_KEY;
      try {
        const res = await listProviderModels('anthropic');
        expect(res.source).toBe('fallback');
        expect(res.models.length).toBeGreaterThan(0);
        expect(res.models).toContain('claude-3-5-sonnet-latest');
      } finally {
        if (prev !== undefined) process.env.MAPLE_ANTHROPIC_API_KEY = prev;
      }
    });

    it('returns fallback models when API key is missing for gemini', async () => {
      const prev = process.env.MAPLE_GEMINI_API_KEY;
      delete process.env.MAPLE_GEMINI_API_KEY;
      try {
        const res = await listProviderModels('gemini');
        expect(res.source).toBe('fallback');
        expect(res.models.length).toBeGreaterThan(0);
        expect(res.models).toContain('gemini-1.5-flash');
      } finally {
        if (prev !== undefined) process.env.MAPLE_GEMINI_API_KEY = prev;
      }
    });

    it('returns fallback models when ollama is unreachable', async () => {
      const res = await listProviderModels('ollama', { url: 'http://127.0.0.1:59999' });
      expect(res.source).toBe('fallback');
      expect(res.models.length).toBeGreaterThan(0);
      expect(res.error).toBeDefined();
    });
  });

  describe('testProviderConnection', () => {
    it('fails when API key is missing for commercial providers', async () => {
      const prev = process.env.MAPLE_OPENAI_API_KEY;
      delete process.env.MAPLE_OPENAI_API_KEY;
      try {
        const res = await testProviderConnection('openai');
        expect(res.ok).toBe(false);
        expect(res.error).toContain('is unset');
      } finally {
        if (prev !== undefined) process.env.MAPLE_OPENAI_API_KEY = prev;
      }
    });

    it('fails when ollama endpoint is unreachable', async () => {
      const res = await testProviderConnection('ollama', { url: 'http://127.0.0.1:59999' });
      expect(res.ok).toBe(false);
      expect(res.error).toBeDefined();
    });

    it('fails when apiKey is explicitly empty even if env var exists', async () => {
      const prev = process.env.MAPLE_OPENAI_API_KEY;
      try {
        process.env.MAPLE_OPENAI_API_KEY = 'sk-valid-key';
        const res = await testProviderConnection('openai', { apiKey: '' });
        expect(res.ok).toBe(false);
        expect(res.error).toContain('is empty');
      } finally {
        if (prev === undefined) {
          delete process.env.MAPLE_OPENAI_API_KEY;
        } else {
          process.env.MAPLE_OPENAI_API_KEY = prev;
        }
      }
    });

    it('returns fallback models when apiKey is explicitly empty even if env var exists', async () => {
      const prev = process.env.MAPLE_OPENAI_API_KEY;
      try {
        process.env.MAPLE_OPENAI_API_KEY = 'sk-valid-key';
        const res = await listProviderModels('openai', { apiKey: '' });
        expect(res.source).toBe('fallback');
        expect(res.error).toBe('No API key provided or found in environment');
      } finally {
        if (prev === undefined) {
          delete process.env.MAPLE_OPENAI_API_KEY;
        } else {
          process.env.MAPLE_OPENAI_API_KEY = prev;
        }
      }
    });
  });
});
