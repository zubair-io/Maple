import { describe, expect, it } from 'bun:test';
import {
  coverageFingerprint,
  documentShapeOf,
  syncIndexAndCoverage,
} from './meilisearch-vector-coverage.ts';
import {
  EMBEDDER_TEMPLATE_SHAPE_VERSION,
  vectorFingerprint,
} from './meilisearch-embedder-template.ts';

describe('documentShapeOf', () => {
  it('extracts the shape prefix so same-shape fingerprints carry forward', () => {
    // Two fingerprints differing only in model/url share a shape: a settings
    // PATCH makes Meilisearch re-embed the documents already in its index,
    // so their coverage is real and can be carried forward.
    expect(documentShapeOf('v8:aaa')).toBe('v8');
    expect(documentShapeOf('v8:bbb')).toBe('v8');
  });

  it('distinguishes a document-shape change', () => {
    // A new shape means the template reads fields the indexed documents do
    // not carry, so the re-embed runs against missing data and must not
    // count as coverage (#2384).
    expect(documentShapeOf('v7:aaa')).not.toBe(documentShapeOf('v8:aaa'));
  });

  it('returns null for an unprefixed legacy fingerprint', () => {
    // Rows written before #2384 carry a bare sha256. They predate every
    // current field and must re-embed rather than be assumed covered.
    expect(documentShapeOf('aaa')).toBeNull();
  });

  it('returns null for a missing or malformed fingerprint', () => {
    expect(documentShapeOf(null)).toBeNull();
    expect(documentShapeOf(undefined)).toBeNull();
    expect(documentShapeOf('')).toBeNull();
    expect(documentShapeOf(':aaa')).toBeNull();
    expect(documentShapeOf('8:aaa')).toBeNull();
  });

  it('matches the shape the live fingerprint actually emits', () => {
    // Guards against the prefix format drifting away from the parser.
    const live = vectorFingerprint({
      embedderName: 'caption',
      embedUrl: 'http://localhost:11434/api/embed',
      model: 'bge-m3',
    });
    // #2992: the live shape prefix now tracks EMBEDDER_TEMPLATE_SHAPE_VERSION,
    // not ASSET_DOC_SHAPE_VERSION — see meilisearch-embedder-template.ts.
    expect(documentShapeOf(live)).toBe(`v${EMBEDDER_TEMPLATE_SHAPE_VERSION}`);
  });
});

describe('coverageFingerprint (#4432)', () => {
  const client = (embedderInSync: boolean | null) => ({
    semanticFingerprint: () => 'v8:settings',
    embedderInSync: () => embedderInSync,
  });

  it('withholds the fingerprint while the live embedder drifts from Settings', () => {
    expect(coverageFingerprint(client(false))).toBeNull();
  });

  it('uses the Settings fingerprint once in sync, or before the first check', () => {
    expect(coverageFingerprint(client(true))).toBe('v8:settings');
    expect(coverageFingerprint(client(null))).toBe('v8:settings');
    expect(coverageFingerprint({ semanticFingerprint: () => null })).toBeNull();
  });
});

describe('syncIndexAndCoverage (#4432)', () => {
  it('reports an unreachable Meilisearch without touching the index', async () => {
    let ensured = false;
    const reachable = await syncIndexAndCoverage({
      health: async () => false,
      ensureIndex: async () => {
        ensured = true;
      },
    });
    expect(reachable).toBe(false);
    expect(ensured).toBe(false);
  });

  it('ensures the index and skips coverage while the embedder drifts', async () => {
    let ensured = false;
    const reachable = await syncIndexAndCoverage({
      health: async () => true,
      ensureIndex: async () => {
        ensured = true;
      },
      semanticFingerprint: () => 'v8:settings',
      embedderInSync: () => false,
    });
    expect(reachable).toBe(true);
    expect(ensured).toBe(true);
  });
});
