/**
 * How one ffmpeg run is judged (#5513), with the run's stderr, exit code and
 * output injected, so every outcome is pinned on hosts without ffmpeg.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtemp, rm, writeFile } from '../fs/mirrored.ts';
import * as os from 'node:os';
import * as path from 'node:path';
import { posterRunFailure, type FfmpegRun } from './video-poster.ts';
import { NoVideoStreamError, SourceDecodeError } from './source-failure.ts';
import { writeSettledFile } from '../test-support/settled-file.ts';

const MOOV_MISSING =
  '[mov,mp4,m4a,3gp,3g2,mj2 @ 0x58565deda3c0] moov atom not found\n[in#0 @ 0x58565deda1c0] Error opening input: Invalid data found when processing input\n';
const NO_STREAMS =
  "Stream map '' matches no streams.\nTo ignore this, add a trailing '?' to the map.\n";
const ENOENT_INPUT =
  '[in#0 @ 0x5613dfe561c0] Error opening input: No such file or directory\nError opening input files: No such file or directory\n';

function failedRun(stderr: string, exitCode: number): FfmpegRun {
  return { timedOut: false, exitCode, stderr, producedBytes: false };
}

let dir = '';
let settledClip = '';
let freshClip = '';

beforeAll(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'poster-outcome-'));
  settledClip = path.join(dir, 'Sequence 01.mov');
  freshClip = path.join(dir, 'copying.mov');
  await writeSettledFile(settledClip, 'bytes');
  await writeFile(freshClip, 'bytes');
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('posterRunFailure', () => {
  it('is null when ffmpeg exited 0 and left bytes', async () => {
    const run = { timedOut: false, exitCode: 0, stderr: '', producedBytes: true };
    expect(await posterRunFailure(run, freshClip, 1)).toBeNull();
  });

  it('fails a clean exit that wrote nothing, as for a clip shorter than the seek', async () => {
    const run = { timedOut: false, exitCode: 0, stderr: '', producedBytes: false };
    expect(await posterRunFailure(run, freshClip, 1)).toEqual({
      videoPath: freshClip,
      exitCode: 0,
      seekSeconds: 1,
      stderr: '',
    });
  });

  it('reports a timeout without reading its output', async () => {
    const run = { timedOut: true, exitCode: 0, stderr: '', producedBytes: true };
    expect(await posterRunFailure(run, freshClip, 0)).toMatchObject({
      exitCode: null,
      stderr: 'timed out',
    });
  });

  it('throws NoVideoStreamError for a container with no video stream', async () => {
    await expect(posterRunFailure(failedRun(NO_STREAMS, 234), freshClip, 0)).rejects.toBeInstanceOf(
      NoVideoStreamError,
    );
  });

  it('throws SourceDecodeError for a missing moov index on a settled file', async () => {
    await expect(
      posterRunFailure(failedRun(MOOV_MISSING, 183), settledClip, 0),
    ).rejects.toBeInstanceOf(SourceDecodeError);
  });

  it('defers a missing moov index on a file modified within the hour', async () => {
    expect(await posterRunFailure(failedRun(MOOV_MISSING, 183), freshClip, 0)).toMatchObject({
      exitCode: 183,
      stderr: MOOV_MISSING.trim(),
    });
  });

  it('defers a missing input, whatever its age', async () => {
    expect(await posterRunFailure(failedRun(ENOENT_INPUT, 254), settledClip, 0)).toMatchObject({
      exitCode: 254,
    });
  });

  it('keeps at most 500 characters of stderr', async () => {
    const failure = await posterRunFailure(failedRun('x'.repeat(900), 1), freshClip, 0);
    expect(failure?.stderr).toHaveLength(500);
  });
});
