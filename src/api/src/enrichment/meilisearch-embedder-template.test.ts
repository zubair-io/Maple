import { describe, expect, it } from 'bun:test';
import {
  ASSET_DOC_SHAPE_VERSION,
  EMBEDDER_DOCUMENT_TEMPLATE,
  vectorFingerprint,
} from './meilisearch-embedder-template.ts';
import { assetsIndexSettings } from './meilisearch-index-settings.ts';

const config = {
  embedderName: 'caption',
  embedUrl: 'http://localhost:11434/api/embed',
  model: 'bge-m3',
};

describe('meilisearch embedder template', () => {
  it('is the single source the index settings use', () => {
    const settings = assetsIndexSettings(
      {
        semantic: true,
        embedderUrl: 'http://localhost:11434',
        embedderModel: 'bge-m3',
      },
      'caption',
    );
    const embedders = settings.embedders as Record<string, { documentTemplate: string }>;
    expect(embedders.caption!.documentTemplate).toBe(EMBEDDER_DOCUMENT_TEMPLATE);
  });

  it('produces a stable, shape-versioned fingerprint', () => {
    const fingerprint = vectorFingerprint(config);
    expect(fingerprint).toBe(vectorFingerprint(config));
    expect(fingerprint.startsWith(`v${ASSET_DOC_SHAPE_VERSION}:`)).toBe(true);
  });

  it('changes when the model changes', () => {
    expect(vectorFingerprint(config)).not.toBe(vectorFingerprint({ ...config, model: 'other' }));
  });

  it('changes when the embed url changes', () => {
    expect(vectorFingerprint(config)).not.toBe(
      vectorFingerprint({
        ...config,
        embedUrl: 'http://elsewhere:11434/api/embed',
      }),
    );
  });
});
