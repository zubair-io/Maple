import * as fs from 'node:fs/promises';
import { child as childLogger } from '../log.ts';
import { ffmpegBinary } from '../thumbs/video-poster.ts';

const log = childLogger('extract-audio');

async function discard(path: string): Promise<void> {
  await fs.unlink(path).catch(() => {});
}

export async function hasAudioStream(mediaPath: string): Promise<boolean> {
  const binary = await ffmpegBinary();
  if (!binary) throw new Error('ffmpeg is unavailable');
  try {
    const proc = Bun.spawn([binary, '-hide_banner', '-i', mediaPath], {
      stdout: 'ignore',
      stderr: 'pipe',
    });
    const timer = setTimeout(() => proc.kill(), 15_000);
    try {
      const stderr = await new Response(proc.stderr).text();
      const code = await proc.exited;
      if (/^\s*Stream #\d+:\d+.*: Audio:/m.test(stderr)) return true;
      // ffmpeg uses a non-zero exit here even for a valid input because no
      // output was requested. A printed stream table proves the container
      // was read successfully; absence of Audio is therefore terminal.
      if (/^\s*Stream #\d+:\d+/m.test(stderr)) return false;
      throw new Error(
        `ffmpeg could not probe media (exit ${code}): ${stderr.trim().slice(0, 300)}`,
      );
    } finally {
      clearTimeout(timer);
    }
  } catch (error) {
    if (error instanceof Error) throw error;
    throw new Error(`ffmpeg audio probe failed: ${String(error)}`, { cause: error });
  }
}

export async function extractAudioWav(mediaPath: string, outWavPath: string): Promise<boolean> {
  const binary = await ffmpegBinary();
  if (!binary) return false;
  try {
    const proc = Bun.spawn(
      [
        binary,
        '-hide_banner',
        '-loglevel',
        'error',
        '-i',
        mediaPath,
        '-vn',
        '-map',
        '0:a:0?',
        '-ac',
        '1',
        '-ar',
        '16000',
        '-f',
        'wav',
        '-y',
        outWavPath,
      ],
      { stdout: 'ignore', stderr: 'pipe' },
    );
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill();
    }, 120_000);
    try {
      const stderr = await new Response(proc.stderr).text();
      const code = await proc.exited;
      const output = await fs.stat(outWavPath).catch(() => null);
      const valid = !timedOut && code === 0 && output !== null && output.size > 44;
      if (valid) return true;
      log.warn({ mediaPath, code, stderr: stderr.trim().slice(0, 300) }, 'audio extraction failed');
      await discard(outWavPath);
      return false;
    } finally {
      clearTimeout(timer);
    }
  } catch (error) {
    log.warn({ mediaPath, error }, 'audio extraction threw');
    await discard(outWavPath);
    return false;
  }
}
