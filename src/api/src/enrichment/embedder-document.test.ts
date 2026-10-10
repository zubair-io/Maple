import { describe, expect, it } from 'bun:test';
import { renderEmbedderDocument, type EmbedderDocument } from './embedder-document.ts';
import { EMBEDDER_TEMPLATE_MAX_BYTES } from './meilisearch-embedder-template.ts';

const EMPTY: EmbedderDocument = {
  filename: null,
  mediaType: null,
  people: null,
  placeText: null,
  description: null,
  transcript: null,
  ocrText: null,
};

const byteLength = (text: string) => new TextEncoder().encode(text).length;

describe('renderEmbedderDocument', () => {
  it('renders every populated field on its own labelled line in template order', () => {
    const text = renderEmbedderDocument({
      filename: 'IMG_0001.jpg',
      mediaType: 'image',
      people: ['Zoe'],
      placeText: 'Lisbon, Portugal',
      description: 'A tram on a hill.',
      transcript: 'hello there',
      ocrText: 'TRAM 28',
    });
    expect(text).toBe(
      [
        'Filename: IMG_0001.jpg',
        'Media type: image',
        'People: Zoe',
        'Place: Lisbon, Portugal',
        'Visual description: A tram on a hill.',
        'Video transcript: hello there',
        'OCR: TRAM 28',
      ].join('\n'),
    );
  });

  it('emits the bare label line for an empty-string field, as Liquid does', () => {
    const text = renderEmbedderDocument({ ...EMPTY, filename: 'a.jpg', ocrText: '' });
    expect(text.endsWith('\nOCR: ')).toBe(true);
    expect(text.split('\n')).toHaveLength(7);
  });

  it('leaves a blank line for a null field', () => {
    expect(renderEmbedderDocument({ ...EMPTY, filename: 'a.jpg', ocrText: 'x' })).toBe(
      'Filename: a.jpg\n\n\n\n\n\nOCR: x',
    );
  });

  it('joins an array of people with no separator', () => {
    const text = renderEmbedderDocument({ ...EMPTY, people: ['Zoe', 'Greyson'] });
    expect(text.split('\n')[2]).toBe('People: ZoeGreyson');
  });

  it('caps the rendered text at the embedder byte limit', () => {
    const text = renderEmbedderDocument({ ...EMPTY, transcript: 'a'.repeat(9000) });
    expect(byteLength(text)).toBe(EMBEDDER_TEMPLATE_MAX_BYTES);
  });

  it('never cuts a multi-byte character in half at the cap', () => {
    const text = renderEmbedderDocument({ ...EMPTY, transcript: '€'.repeat(3000) });
    expect(byteLength(text)).toBeLessThanOrEqual(EMBEDDER_TEMPLATE_MAX_BYTES);
    expect(byteLength(text)).toBeGreaterThan(EMBEDDER_TEMPLATE_MAX_BYTES - 3);
    expect(text).not.toContain('�');
  });

  it('leaves text of exactly the limit untouched', () => {
    const baseline = byteLength(renderEmbedderDocument({ ...EMPTY, transcript: '' }));
    const text = renderEmbedderDocument({
      ...EMPTY,
      transcript: 'a'.repeat(EMBEDDER_TEMPLATE_MAX_BYTES - baseline),
    });
    expect(byteLength(text)).toBe(EMBEDDER_TEMPLATE_MAX_BYTES);
    expect(text.endsWith('a\n')).toBe(true);
  });
});
