import { describe, expect, it } from 'bun:test';
import { assetsIndexSettings, assetsIndexSettingsMatch } from './meilisearch-index-settings.ts';

const semanticConfig = {
  semantic: true,
  embedderUrl: 'http://localhost:11434',
  embedderModel: 'bge-m3',
};

function settings(): Record<string, unknown> {
  return assetsIndexSettings(semanticConfig, 'caption');
}

describe('searchable attribute order', () => {
  it('ranks named people and transcript above generic captions, filename first', () => {
    // Meilisearch's `attribute` ranking rule favours matches in EARLIER
    // attributes. This order encodes three claims about intent:
    //   filename  — exact-identifier queries must stay top-1 (#2384 AC7)
    //   people    — a name query wants photos OF that person, not a
    //               transcript or OCR that mentions the name in passing
    //   transcript/ocrText/description — what was actually said or written
    //               outranks what a captioner guessed
    // searchBlob stays LAST: it is the only home for the structured vision
    // tokens, so it must remain searchable, but at the lowest weight.
    expect(settings().searchableAttributes).toEqual([
      'filename',
      'people',
      'transcript',
      'ocrText',
      'description',
      'placeText',
      'searchBlob',
    ]);
  });

  it('treats a reordering as a settings change so boot re-PATCHes the index', () => {
    // searchableAttributes order is ranking-significant, so the comparison
    // must be order-SENSITIVE. If it were set-based, shipping a new order
    // would silently never reach Meilisearch.
    const expected = settings();
    const sameSetDifferentOrder = {
      ...expected,
      searchableAttributes: [
        'filename',
        'transcript',
        'people',
        'ocrText',
        'description',
        'placeText',
        'searchBlob',
      ],
    };
    expect(assetsIndexSettingsMatch(sameSetDifferentOrder, expected)).toBe(false);
    expect(assetsIndexSettingsMatch(expected, expected)).toBe(true);
  });

  it('every searchable attribute except searchBlob is a document field', () => {
    // searchBlob is the one attribute deliberately absent from the embedder
    // template; the rest must all be fields a writer actually populates.
    const searchable = settings().searchableAttributes as string[];
    expect(searchable).toContain('searchBlob');
    expect(searchable.filter((name) => name !== 'searchBlob')).toEqual([
      'filename',
      'people',
      'transcript',
      'ocrText',
      'description',
      'placeText',
    ]);
  });
});

describe('embedder dimensions', () => {
  function embedder(model: string): Record<string, unknown> {
    const s = assetsIndexSettings(
      { semantic: true, embedderUrl: 'http://localhost:11434', embedderModel: model },
      'caption',
    );
    return (s.embedders as Record<string, Record<string, unknown>>).caption!;
  }

  it('declares the output size for models we know', () => {
    // Supplying `dimensions` makes Meilisearch skip its own dimension probe,
    // which is a request to the embedding server that can fail independently
    // of everything else and takes the whole embedder registration down.
    expect(embedder('bge-m3').dimensions).toBe(1024);
    expect(embedder('nomic-embed-text').dimensions).toBe(768);
  });

  it('ignores a tag suffix when resolving the model', () => {
    expect(embedder('bge-m3:latest').dimensions).toBe(1024);
  });

  it('omits dimensions for a model we do not know', () => {
    // Guessing here would be worse than probing: a wrong `dimensions` makes
    // Meilisearch reject or truncate every vector. The model is an
    // operator-settable value, so unknown models must fall back to the probe.
    expect(embedder('some-private-embedder').dimensions).toBeUndefined();
  });
});

describe('settings comparison and dimensions', () => {
  function settingsFor(model: string): Record<string, unknown> {
    return assetsIndexSettings(
      { semantic: true, embedderUrl: 'http://localhost:11434', embedderModel: model },
      'caption',
    );
  }

  it('re-PATCHes when a known model is stored without our dimensions', () => {
    const expected = settingsFor('bge-m3');
    const actual = JSON.parse(JSON.stringify(expected)) as Record<string, unknown>;
    delete (actual.embedders as Record<string, Record<string, unknown>>).caption!.dimensions;
    expect(assetsIndexSettingsMatch(actual, expected)).toBe(false);
  });

  it('does NOT re-PATCH when Meilisearch probed dimensions for a model we do not know', () => {
    // The boot-loop trap: for an unknown model we send no `dimensions`, but
    // Meilisearch probes one and echoes it back. Comparing it unconditionally
    // would mismatch on every boot, and every PATCH re-embeds the whole index.
    const expected = settingsFor('some-private-embedder');
    const actual = JSON.parse(JSON.stringify(expected)) as Record<string, unknown>;
    (actual.embedders as Record<string, Record<string, unknown>>).caption!.dimensions = 768;
    expect(assetsIndexSettingsMatch(actual, expected)).toBe(true);
  });
});
