import { describe, expect, it } from 'bun:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { extractAudioWav, hasAudioStream } from './extract-audio.ts';

describe('audio extraction failure contract', () => {
  it('distinguishes an unreadable file from valid media with no audio', async () => {
    const missing = join(tmpdir(), `maple-missing-${crypto.randomUUID()}.mp4`);
    await expect(hasAudioStream(missing)).rejects.toThrow('could not probe media');
    expect(await extractAudioWav(missing, `${missing}.wav`)).toBe(false);
  });
});
