import { describe, expect, it } from 'bun:test';
import { parseVideoJson, VideoParseError } from './parse-video-json.ts';

const TIMESTAMPS = [0, 1.5, 3];

function validJson(): string {
  return JSON.stringify({
    summary: 'A child runs across a yard, then sits on a swing.',
    scenes: [
      { frame_index: 0, caption: 'A child runs across a green yard.', text_visible: null },
      { frame_index: 1, caption: 'The child climbs onto a swing set.', text_visible: 'SLOW' },
      { frame_index: 2, caption: 'The child swings, smiling at the camera.', text_visible: null },
    ],
  });
}

describe('parseVideoJson', () => {
  it('parses a well-formed response and maps frame_index to real timestamps', () => {
    const doc = parseVideoJson(validJson(), TIMESTAMPS);
    expect(doc.summary).toBe('A child runs across a yard, then sits on a swing.');
    expect(doc.scenes).toEqual([
      { timestamp_ms: 0, caption: 'A child runs across a green yard.', text_visible: null },
      { timestamp_ms: 1500, caption: 'The child climbs onto a swing set.', text_visible: 'SLOW' },
      {
        timestamp_ms: 3000,
        caption: 'The child swings, smiling at the camera.',
        text_visible: null,
      },
    ]);
  });

  it('sorts scenes chronologically even when the model emits them out of order', () => {
    const raw = JSON.stringify({
      summary: 'out of order',
      scenes: [
        { frame_index: 2, caption: 'last frame', text_visible: null },
        { frame_index: 0, caption: 'first frame', text_visible: null },
      ],
    });
    const doc = parseVideoJson(raw, TIMESTAMPS);
    expect(doc.scenes.map((s) => s.timestamp_ms)).toEqual([0, 3000]);
    expect(doc.scenes[0]!.caption).toBe('first frame');
  });

  it('strips a markdown fence wrapper', () => {
    const doc = parseVideoJson('```json\n' + validJson() + '\n```', TIMESTAMPS);
    expect(doc.scenes).toHaveLength(3);
  });

  it('throws empty-response on an empty string', () => {
    expect(() => parseVideoJson('', TIMESTAMPS)).toThrow(VideoParseError);
    try {
      parseVideoJson('', TIMESTAMPS);
    } catch (e) {
      expect((e as VideoParseError).reason).toBe('empty-response');
    }
  });

  it('throws not-json on malformed JSON', () => {
    expect(() => parseVideoJson('{not valid', TIMESTAMPS)).toThrow(VideoParseError);
  });

  it('throws not-object when the root is an array', () => {
    expect(() => parseVideoJson('[]', TIMESTAMPS)).toThrow(VideoParseError);
  });

  it('throws missing-field when summary is absent or empty', () => {
    const raw = JSON.stringify({ summary: '', scenes: [] });
    try {
      parseVideoJson(raw, TIMESTAMPS);
      throw new Error('expected to throw');
    } catch (e) {
      expect(e).toBeInstanceOf(VideoParseError);
      expect((e as VideoParseError).reason).toBe('missing-field');
    }
  });

  it('throws bad-frame-index on an out-of-range index', () => {
    const raw = JSON.stringify({
      summary: 'x',
      scenes: [{ frame_index: 99, caption: 'y', text_visible: null }],
    });
    try {
      parseVideoJson(raw, TIMESTAMPS);
      throw new Error('expected to throw');
    } catch (e) {
      expect((e as VideoParseError).reason).toBe('bad-frame-index');
    }
  });

  it('throws bad-frame-index on a negative or non-integer index', () => {
    const negative = JSON.stringify({
      summary: 'x',
      scenes: [{ frame_index: -1, caption: 'y', text_visible: null }],
    });
    expect(() => parseVideoJson(negative, TIMESTAMPS)).toThrow(VideoParseError);

    const fractional = JSON.stringify({
      summary: 'x',
      scenes: [{ frame_index: 1.5, caption: 'y', text_visible: null }],
    });
    expect(() => parseVideoJson(fractional, TIMESTAMPS)).toThrow(VideoParseError);
  });

  it('throws duplicate-frame-index when the same index repeats', () => {
    const raw = JSON.stringify({
      summary: 'x',
      scenes: [
        { frame_index: 0, caption: 'a', text_visible: null },
        { frame_index: 0, caption: 'b', text_visible: null },
      ],
    });
    try {
      parseVideoJson(raw, TIMESTAMPS);
      throw new Error('expected to throw');
    } catch (e) {
      expect((e as VideoParseError).reason).toBe('duplicate-frame-index');
    }
  });

  it('throws wrong-type when text_visible is neither a string nor null', () => {
    const raw = JSON.stringify({
      summary: 'x',
      scenes: [{ frame_index: 0, caption: 'a', text_visible: 42 }],
    });
    expect(() => parseVideoJson(raw, TIMESTAMPS)).toThrow(VideoParseError);
  });

  it('accepts an empty scenes array (model saw nothing worth calling out)', () => {
    const raw = JSON.stringify({ summary: 'A static shot of a wall.', scenes: [] });
    const doc = parseVideoJson(raw, TIMESTAMPS);
    expect(doc.scenes).toEqual([]);
  });

  it('never fabricates a timestamp — every value comes from the caller-supplied array', () => {
    // frame_index only ever indexes into TIMESTAMPS; a model can't smuggle
    // an arbitrary time through the response even if it tries.
    const raw = JSON.stringify({
      summary: 'x',
      scenes: [{ frame_index: 1, caption: 'y', text_visible: null }],
    });
    const doc = parseVideoJson(raw, TIMESTAMPS);
    expect(doc.scenes[0]!.timestamp_ms).toBe(Math.round(TIMESTAMPS[1]! * 1000));
  });
});
