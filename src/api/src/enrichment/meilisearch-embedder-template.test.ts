import { describe, expect, it } from 'bun:test';
import {
  ASSET_DOC_SHAPE_VERSION,
  EMBEDDER_DOCUMENT_TEMPLATE,
  EMBEDDER_TEMPLATE_MAX_BYTES,
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

  it('orders fields by value-per-byte, because the tail is what truncation drops', () => {
    // Meilisearch truncates the RENDERED template to
    // EMBEDDER_TEMPLATE_MAX_BYTES before embedding, so position is priority.
    const at = (field: string): number => {
      const index = EMBEDDER_DOCUMENT_TEMPLATE.indexOf(field);
      expect(index).toBeGreaterThan(-1);
      return index;
    };
    // Short, high-precision fields first.
    for (const field of ['doc.filename', 'doc.mediaType', 'doc.people', 'doc.placeText']) {
      expect(at(field)).toBeLessThan(at('doc.description'));
    }
    // Transcript is the point of #2384 — it must outrank OCR, or a
    // screenshot's chrome text would crowd out what was actually said.
    expect(at('doc.description')).toBeLessThan(at('doc.transcript'));
    expect(at('doc.transcript')).toBeLessThan(at('doc.ocrText'));
  });

  it('raises the byte ceiling well above Meilisearch’s 400-byte default', () => {
    // 400 bytes is roughly 50 alphabetised tokens — the silent truncation
    // that made the old template near-useless (#2384).
    expect(EMBEDDER_TEMPLATE_MAX_BYTES).toBeGreaterThanOrEqual(4000);
  });

  it('guards every field reference so a settings change cannot fail on old documents', () => {
    // The deployment trap (#2384): Meilisearch re-renders this template
    // against the documents ALREADY in its index the moment embedder settings
    // change. Those documents predate any newly-added field, and a bare
    // `{{ doc.x }}` against them fails the entire settingsUpdate task with
    // `invalid_document_fields` — the migration can never start.
    // TEMPLATE_FIELD_DEFAULTS cannot help: it back-fills documents we SEND,
    // not the millions already indexed.
    for (const line of EMBEDDER_DOCUMENT_TEMPLATE.split('\n')) {
      if (!line.includes('doc.')) continue;
      const guarded = /^\{% if doc\.(\w+) %\}[^{]*\{\{ doc\.\1 \}\}[^{]*\{% endif %\}$/.exec(line);
      expect(guarded, `unguarded template line: ${line}`).not.toBeNull();
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
