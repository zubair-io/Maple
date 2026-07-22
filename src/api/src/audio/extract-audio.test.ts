import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ffmpegBinary } from '../thumbs/video-poster.ts';
import { extractAudioWav, hasAudioStream } from './extract-audio.ts';

let dir: string;
let clip: string | null = null;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'maple-extract-audio-'));
  const ffmpeg = await ffmpegBinary();
  if (!ffmpeg) return;
  const output = join(dir, 'with-audio.mp4');
  const proc = Bun.spawn(
    [
      ffmpeg,
      '-hide_banner',
      '-loglevel',
      'error',
      '-f',
      'lavfi',
      '-i',
      'color=black:size=32x32:duration=0.2',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:duration=0.2',
      '-shortest',
      '-y',
      output,
    ],
    { stdout: 'ignore', stderr: 'ignore' },
  );
  if ((await proc.exited) === 0) clip = output;
});

afterAll(async () => rm(dir, { recursive: true, force: true }));

describe('audio extraction failure contract', () => {
  it('distinguishes an unreadable file from valid media with no audio', async () => {
    const missing = join(tmpdir(), `maple-missing-${crypto.randomUUID()}.mp4`);
    await expect(hasAudioStream(missing)).rejects.toThrow();
    expect(await extractAudioWav(missing, `${missing}.wav`)).toBe(false);
  });

  it('detects and extracts a real audio stream when ffmpeg is available', async () => {
    if (!clip) return;
    expect(await hasAudioStream(clip)).toBe(true);
    const wav = join(dir, 'audio.wav');
    expect(await extractAudioWav(clip, wav)).toBe(true);
    expect((await stat(wav)).size).toBeGreaterThan(44);
  });
});
