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
