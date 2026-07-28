import { describe, expect, it } from 'bun:test';
import {
  MAX_INDEXED_TRANSCRIPT_CHARS,
  placeTextForIndex,
  transcriptForIndex,
} from './asset-doc-fields.ts';

describe('transcriptForIndex', () => {
  it('returns null for a missing transcript', () => {
    expect(transcriptForIndex(null)).toBeNull();
    expect(transcriptForIndex(undefined)).toBeNull();
    expect(transcriptForIndex({})).toBeNull();
    expect(transcriptForIndex({ text: '   ' })).toBeNull();
  });

  it('preserves prose word order and repetition', () => {
    // The whole point of this field: `search_blob` would deliver these words
    // lowercased, deduped, and alphabetised, which is useless to an embedder.
    const text = 'We just have the heat pumps installed on the Harmony 3 zone controller.';
    expect(transcriptForIndex({ text })).toBe(text);
  });

  it('caps very long transcripts at a whitespace boundary', () => {
    const long = 'word '.repeat(MAX_INDEXED_TRANSCRIPT_CHARS);
    const capped = transcriptForIndex({ text: long })!;
    expect(capped.length).toBeLessThanOrEqual(MAX_INDEXED_TRANSCRIPT_CHARS);
    expect(capped.endsWith(' ')).toBe(false);
    expect(capped.startsWith('word word')).toBe(true);
  });

  it('leaves a transcript exactly at the cap untouched', () => {
    const exact = 'a'.repeat(MAX_INDEXED_TRANSCRIPT_CHARS);
    expect(transcriptForIndex({ text: exact })).toBe(exact);
  });

  it('falls back to a hard cut when the window has no whitespace', () => {
    const unbroken = 'a'.repeat(MAX_INDEXED_TRANSCRIPT_CHARS + 50);
    expect(transcriptForIndex({ text: unbroken })!.length).toBe(MAX_INDEXED_TRANSCRIPT_CHARS);
  });
});

describe('placeTextForIndex', () => {
  it('prefers the prose display name over nothing', () => {
    expect(placeTextForIndex({ display_name: '12 Elm St, Albany, NY, USA' })).toBe(
      '12 Elm St, Albany, NY, USA',
    );
  });

  it('returns null when there is no place or no display name', () => {
    expect(placeTextForIndex(null)).toBeNull();
    expect(placeTextForIndex(undefined)).toBeNull();
    expect(placeTextForIndex({ display_name: null })).toBeNull();
    expect(placeTextForIndex({ display_name: '  ' })).toBeNull();
  });
});
