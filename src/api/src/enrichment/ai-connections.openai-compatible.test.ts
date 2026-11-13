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
    },
  };
}

describe('OpenAI-compatible connections', () => {
  it('accept a base URL', () => {
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

  it('can also serve generated search', () => {
    const config = strataConfig();
    config.assignments['generated-search'] = { connection_ids: ['strata'], model: 'qwen' };
    expect(validateAiConnections(config)).toBeNull();
  });

  it('may run without a key for generated search, never for the vision workers', () => {
    const config = strataConfig();
    config.connections[1]!.api_key = null;
    config.assignments.describe = { connection_ids: ['ollama-1'], model: 'qwen2.5-vl' };
    config.assignments['video-describe'] = { connection_ids: ['ollama-1'], model: 'qwen2.5-vl' };
    config.assignments['generated-search'] = { connection_ids: ['strata'], model: 'qwen' };
    expect(validateAiConnections(config)).toBeNull();

    config.assignments.describe = { connection_ids: ['strata'], model: 'qwen2.5-vl' };
    expect(validateAiConnections(config)).toBe('Describe needs an API key on Strata.');
  });

  it('still need a key to reach OpenAI itself', () => {
    const config = strataConfig('');
    config.connections[1]!.api_key = null;
    expect(validateAiConnections(config)).toBe('Strata needs an API key.');
  });

  it('no longer accept a semantic-search assignment: it runs on the bundled model', () => {
    const config = strataConfig();
    config.assignments['semantic-search'] = { connection_ids: ['strata'], model: 'bge-m3' };
    expect(validateAiConnections(config)).toBe('Unknown worker assignment.');
  });

  it('never expose a connection key in the public enrichment config', async () => {
    const pub = await toPublicConfig(
      resolveEnrichmentConfig(
        { nominatim_url: null, geocode_worker_enabled: true, ai_connections: strataConfig() },
        {},
      ),
    );
    expect(JSON.stringify(pub)).not.toContain('sk-strata');
  });
});
