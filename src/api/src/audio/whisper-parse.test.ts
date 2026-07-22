import { describe, expect, it } from 'bun:test';
import { parseWhisperJson, WhisperParseError } from './whisper-parse.ts';

describe('parseWhisperJson', () => {
  it('normalises segments and converts milliseconds to seconds', () => {
    const result = parseWhisperJson(
      JSON.stringify({
        result: { language: 'en' },
        transcription: [
          { offsets: { from: 0, to: 2000 }, text: ' Hello there.' },
          { offsets: { from: 2000, to: 5500 }, text: ' General Kenobi.' },
        ],
      }),
    );
    expect(result.text).toBe('Hello there. General Kenobi.');
    expect(result.segments[1]).toEqual({ start: 2, end: 5.5, text: 'General Kenobi.' });
  });

  it('accepts silence and defaults language to English', () => {
    expect(parseWhisperJson('{"transcription":[]}')).toEqual({
      text: '',
      segments: [],
      language: 'en',
    });
  });

  it('rejects unusable output', () => {
    expect(() => parseWhisperJson('nope')).toThrow(WhisperParseError);
    expect(() => parseWhisperJson('{"transcription":"nope"}')).toThrow(WhisperParseError);
  });
});
