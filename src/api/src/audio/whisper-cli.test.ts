import { describe, expect, it } from 'bun:test';
import { isAbsolute } from 'node:path';
import { transcribeWav, whisperBinary } from './whisper-cli.ts';

describe('whisper CLI', () => {
  it('resolves to an absolute executable or null', async () => {
    const binary = await whisperBinary();
    expect(binary === null || isAbsolute(binary)).toBe(true);
  });

  it('returns null when inputs are missing', async () => {
    expect(await transcribeWav('/missing.wav', '/missing-model.bin')).toBeNull();
  });
});
