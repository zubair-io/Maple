import { describe, expect, it } from 'bun:test';
import {
  ASSET_DOC_SHAPE_VERSION,
  EMBEDDER_DOCUMENT_TEMPLATE,
  TEMPLATE_FIELD_DEFAULTS,
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

describe('template content', () => {
  it('does not duplicate description text via searchBlob', () => {
    // searchBlob already contains every description token — and does so as a
    // lowercased, deduped, ALPHABETISED bag, which is worse than useless as
    // embedder input. Excluding it is the core of #2384.
    expect(EMBEDDER_DOCUMENT_TEMPLATE).not.toContain('doc.searchBlob');
    expect(EMBEDDER_DOCUMENT_TEMPLATE).toContain('doc.description');
  });

  it('labels every source so the embedder sees field semantics', () => {
    for (const label of [
      'Filename:',
      'Media type:',
      'People:',
      'Visual description:',
      'Place:',
      'OCR:',
      'Video transcript:',
    ]) {
      expect(EMBEDDER_DOCUMENT_TEMPLATE).toContain(label);
    }
  });

  it('puts the transcript last so context truncation eats its tail, not the dense fields', () => {
    const transcriptAt = EMBEDDER_DOCUMENT_TEMPLATE.indexOf('doc.transcript');
    expect(transcriptAt).toBeGreaterThan(0);
    for (const field of ['doc.filename', 'doc.people', 'doc.description', 'doc.placeText']) {
      expect(EMBEDDER_DOCUMENT_TEMPLATE.indexOf(field)).toBeLessThan(transcriptAt);
    }
  });

  it('references only keys that TEMPLATE_FIELD_DEFAULTS covers', () => {
    // The #2369 invariant, enforced structurally: a document missing any key
    // the template dereferences rejects its ENTIRE batch. Derived from the
    // template string itself, so adding `{{ doc.x }}` without a default here
    // fails immediately rather than in production during a backfill.
    const referenced = [...EMBEDDER_DOCUMENT_TEMPLATE.matchAll(/doc\.(\w+)/g)].map((m) => m[1]!);
    expect(referenced.length).toBeGreaterThan(0);
    for (const key of referenced) {
      expect(Object.keys(TEMPLATE_FIELD_DEFAULTS)).toContain(key);
    }
  });
});
