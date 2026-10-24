import { describe, it, expect } from 'bun:test';
import { validateAiConnections, type AiConnectionsConfig } from './ai-connections.ts';
import { resolveEnrichmentConfig } from './enrichment-config.resolve.ts';
import { toPublicConfig } from '../routes/enrichment-public-config.ts';

const STRATA_URL = 'http://192.168.0.23:8080/v1';

function strataConfig(url = STRATA_URL): AiConnectionsConfig {
  return {
    connections: [
      {
        id: 'ollama-1',
        name: 'Ollama',
        provider: 'ollama',
        url: 'http://ollama:11434',
        concurrency: 2,
      },
      {
        id: 'strata',
        name: 'Strata',
        provider: 'openai',
        url,
        concurrency: 2,
        api_key: 'sk-strata',
      },
    ],
    assignments: {
      describe: { connection_ids: ['strata'], model: 'qwen2.5-vl' },
      'video-describe': { connection_ids: ['strata'], model: 'qwen2.5-vl' },
      'generated-search': { connection_ids: ['ollama-1'], model: 'gemma4:12b' },
      'semantic-search': { connection_ids: ['strata'], model: 'BAAI/bge-m3' },
    },
  };
}

function resolved(ai: AiConnectionsConfig, embedderUrl: string | null = null) {
  return resolveEnrichmentConfig(
    {
      nominatim_url: null,
      geocode_worker_enabled: true,
      ai_connections: ai,
      embedder_url: embedderUrl,
    },
    {},
  );
}

describe('OpenAI-compatible connections', () => {
  it('accept a base URL and serve semantic search', () => {
    expect(validateAiConnections(strataConfig())).toBeNull();
  });

  it('reject a base URL that is not plain HTTP(S)', () => {
    expect(validateAiConnections(strataConfig('ftp://strata/v1'))).toBe(
      'Use an HTTP(S) endpoint without credentials, query or fragment.',
    );
    expect(validateAiConnections(strataConfig('http://user:pw@strata/v1'))).toBe(
      'Use an HTTP(S) endpoint without credentials, query or fragment.',
    );
  });

  it('still keep generated search on Ollama', () => {
    const config = strataConfig();
    config.assignments['generated-search'] = { connection_ids: ['strata'], model: 'qwen' };
    expect(validateAiConnections(config)).toBe(
      'Generated search supports only ollama connections.',
    );
  });

  it('embed over the OpenAI protocol with the connection key', () => {
    const r = resolved(strataConfig());
    expect(r.embedder_url).toBe(STRATA_URL);
    expect(r.embedder_model).toBe('BAAI/bge-m3');
    expect(r.embedder_protocol).toBe('openai');
    expect(r.embedder_api_key).toBe('sk-strata');
  });

  it('embed against OpenAI itself when the connection has no base URL', () => {
    const r = resolved(strataConfig(''));
    expect(r.embedder_url).toBe('https://api.openai.com/v1');
    expect(r.embedder_protocol).toBe('openai');
  });

  it('treat a saved embedder endpoint override as an Ollama server without a key', () => {
    const r = resolved(strataConfig(), 'http://embed.lan:11434');
    expect(r.embedder_url).toBe('http://embed.lan:11434');
    expect(r.embedder_protocol).toBe('ollama');
    expect(r.embedder_api_key).toBeNull();
  });

  it('never expose the embedder key in the public enrichment config', async () => {
    const pub = await toPublicConfig(resolved(strataConfig()));
    expect('embedder_api_key' in pub).toBe(false);
    expect(JSON.stringify(pub)).not.toContain('sk-strata');
  });
});
