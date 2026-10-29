/**
 * The permanent-source-failure signatures (#5513), pinned against the exact
 * text production logged for them, and against the server-side failures that
 * must never match: those defer instead of tagging an original damaged.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtemp, rm, utimes, writeFile } from '../fs/mirrored.ts';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  NoVideoStreamError,
  SourceDecodeError,
  permanentSourceFailure,
  throwIfPermanentSourceFailure,
} from './source-failure.ts';

const UNDECODABLE = [
  'input buffer is not a HEIC image',
  "Invalid signature: 'II*\u0000' at 0x0",
  'rawler failed to decode <memory>: cannot identify raster image format',
];

const MOOV_MISSING =
  '[mov,mp4,m4a,3gp,3g2,mj2 @ 0x5ceefd31f3c0] moov atom not found\n[in#0 @ 0x5ceefd31f1c0] Error opening input: Invalid data found when processing input\nError opening input file /srv/photos/Sequence 01.mov.\nError opening input files: Invalid data found when processing input';

const TRUNCATED = [
  'rawler failed to decode <memory>: JPEG-compressed TIFF decode failed: failed to fill whole buffer',
  'rawler failed to decode <memory>: jpeg decode failed: I/O errors Not enough bytes, expected 1 but found 0\n',
  MOOV_MISSING,
];

const NO_VIDEO_STREAM =
  "Stream map '' matches no streams.\nTo ignore this, add a trailing '?' to the map.\nFailed to set value '0:v:0' for option 'map': Invalid argument\nError parsing options for output file /srv/photos/CONTENTS/AUDIO/.maple/previews/0008DD02.MXF.avif.tmp.65.6367d3963d04afe3.poster.jpg.\nError opening output files: Invalid argument";

const SERVER_SIDE = [
  'render-failed (see child stderr)',
  'child exited',
  "ENOENT: no such file or directory, open '/srv/photos/2022/misc/IMG_8650.JPG'",
  "EACCES: permission denied, open '/srv/photos/a.heic'",
  'ENOSPC: no space left on device, write',
  'EXDEV: cross-device link not permitted',
  '[in#0 @ 0x5613dfe561c0] Error opening input: No such file or directory\nError opening input file /srv/photos/2022/misc/RingVideo_20220331_084059.mp4.\nError opening input files: No such file or directory',
  'timed out',
  'rawler failed to decode <memory>: encode failed: out of memory',
];

describe('permanentSourceFailure', () => {
  it.each(UNDECODABLE)('classifies %p as undecodable', (message) => {
    expect(permanentSourceFailure(message)).toBe('undecodable');
  });

  it.each(TRUNCATED)('classifies %p as truncated', (message) => {
    expect(permanentSourceFailure(message)).toBe('truncated');
  });

  it('classifies a container with no stream for the video map as no-video-stream', () => {
    expect(permanentSourceFailure(NO_VIDEO_STREAM)).toBe('no-video-stream');
  });

  it.each(SERVER_SIDE)('leaves %p unclassified so it defers', (message) => {
    expect(permanentSourceFailure(message)).toBeNull();
  });
});

describe('throwIfPermanentSourceFailure', () => {
  let dir = '';
  const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60_000);

  beforeAll(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'source-failure-'));
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function original(name: string, mtime?: Date): Promise<string> {
    const file = path.join(dir, name);
    await writeFile(file, 'bytes');
    if (mtime) await utimes(file, mtime, mtime);
    return file;
  }

  it('throws SourceDecodeError for a format mismatch however fresh the file', async () => {
    const heic = await original('IMG_1.HEIC');
    await expect(
      throwIfPermanentSourceFailure('input buffer is not a HEIC image', heic),
    ).rejects.toThrow(new SourceDecodeError(heic, 'input buffer is not a HEIC image').message);
  });

  it('defers a truncation on a file modified within the last hour', async () => {
    const copying = await original('copying.mov');
    await expect(throwIfPermanentSourceFailure(MOOV_MISSING, copying)).resolves.toBeUndefined();
  });

  it('throws SourceDecodeError for a truncation on a file settled for over an hour', async () => {
    const settled = await original('Sequence 01.mov', twoHoursAgo);
    await expect(throwIfPermanentSourceFailure(MOOV_MISSING, settled)).rejects.toBeInstanceOf(
      SourceDecodeError,
    );
  });

  it('defers a truncation when the file cannot be stat-ed', async () => {
    await expect(
      throwIfPermanentSourceFailure(MOOV_MISSING, path.join(dir, 'gone.mov')),
    ).resolves.toBeUndefined();
  });

  it('throws NoVideoStreamError for a container with no video stream', async () => {
    const audio = await original('0008DD02.MXF');
    await expect(throwIfPermanentSourceFailure(NO_VIDEO_STREAM, audio)).rejects.toBeInstanceOf(
      NoVideoStreamError,
    );
  });

  it('resolves for a server-side failure', async () => {
    const raw = await original('a.fff', twoHoursAgo);
    await expect(
      throwIfPermanentSourceFailure('render-failed (see child stderr)', raw),
    ).resolves.toBeUndefined();
  });
});
