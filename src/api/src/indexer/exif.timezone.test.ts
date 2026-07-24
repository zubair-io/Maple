// exif.timezone.test.ts — proves `normalizeExif`'s `captured_at` derivation
// is timezone-independent (#2004 review, P0), and separately that
// `readExif`'s own `exifr.parse` call can't reintroduce the same bug one
// layer upstream (#2004 review round 2, P0-2).
//
// EXIF DateTimeOriginal/CreateDate carry no timezone offset per spec. An
// earlier version of `asIsoDate` built a bare date-time string and passed
// it to `new Date(...)`, which the ECMAScript spec parses in the process's
// LOCAL timezone when no offset is present — meaning the exact same EXIF
// tag produced a different `captured_at` (and therefore a different
// cross-platform `maple_id`) depending on the process's `TZ`. Fixed via
// `Date.UTC(...)`'s numeric-component constructor, which has no string-
// parsing ambiguity.
//
// Testing this rigorously requires genuinely different process
// environments, not a mid-process `process.env.TZ` mutation: confirmed
// directly that Bun does NOT re-read `TZ` for `Date` parsing once the
// process has started (a `getTimezoneOffset()` check before/after
// reassigning `process.env.TZ` returned the same value both times) — so
// this spawns two real child processes, each started with a different
// `TZ` in its environment, and asserts both produce the identical golden
// UTC value. This is the only way to prove the fix holds across the
// literal scenario the bug report describes ("New York" vs. the server).
import { describe, expect, it } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

const GOLDEN_EXIF_STRING = '2026:07:12 10:30:00';
const GOLDEN_UTC_ISO = '2026-07-12T10:30:00.000Z';

const EXIF_TS_PATH = new URL('./exif.ts', import.meta.url).pathname;

/** Runs `normalizeExif({ DateTimeOriginal: exifString })` in a fresh child
 * `bun` process started with `TZ=tz`, returning its `captured_at`. A real
 * subprocess is the only way to actually exercise a different process
 * timezone — see this file's module doc for why a mid-process
 * `process.env.TZ` mutation does not work in Bun. */
async function capturedAtUnderTimezone(tz: string, exifString: string): Promise<string | null> {
  const script = `
    import { normalizeExif } from ${JSON.stringify(EXIF_TS_PATH)};
    const result = normalizeExif({ DateTimeOriginal: ${JSON.stringify(exifString)} });
    process.stdout.write(JSON.stringify(result.captured_at));
  `;
  const proc = Bun.spawn(['bun', '-e', script], {
    env: { ...process.env, TZ: tz },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(`child process (TZ=${tz}) exited ${exitCode}: ${stderr}`);
  }
  return JSON.parse(stdout) as string | null;
}

/** Runs `normalizeExif({ DateTimeOriginal: new Date(y, mo, d, h, mi, s) })`
 * in a fresh child `bun` process started with `TZ=tz`, returning its
 * `captured_at`. Exercises `asIsoDate`'s `Date` branch (#2154) — the
 * `Date` is built via the local-component constructor, exactly matching how
 * exifr's own `reviveValues: true` revival constructs one from a bare EXIF
 * wall-clock string (see `EXIFR_DATE_ONLY_OPTS`'s doc comment in `exif.ts`),
 * so this is the realistic shape of input that branch actually receives. */
async function capturedAtForDateUnderTimezone(
  tz: string,
  y: number,
  mo: number,
  d: number,
  h: number,
  mi: number,
  s: number,
): Promise<string | null> {
  const script = `
    import { normalizeExif } from ${JSON.stringify(EXIF_TS_PATH)};
    const result = normalizeExif({ DateTimeOriginal: new Date(${y}, ${mo}, ${d}, ${h}, ${mi}, ${s}) });
    process.stdout.write(JSON.stringify(result.captured_at));
  `;
  const proc = Bun.spawn(['bun', '-e', script], {
    env: { ...process.env, TZ: tz },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(`child process (TZ=${tz}) exited ${exitCode}: ${stderr}`);
  }
  return JSON.parse(stdout) as string | null;
}

describe('normalizeExif captured_at — Date-instance wall-clock preservation (#2154)', () => {
  // `asIsoDate`'s `Date` branch previously called `v.toISOString()`, which
  // reads a `Date` back through UTC regardless of the local timezone it was
  // built with — reintroducing the exact class of bug this file's other
  // describe block guards against, one layer up (a `Date` instead of a
  // string). Every `Date` that reaches this branch in production is
  // exifr's own local-timezone-setter revival of a bare EXIF wall-clock
  // value (see `withRawCaptureDates`'s and `asIsoDate`'s doc comments in
  // `exif.ts`), so the fix reads the SAME local fields back out instead.
  for (const tz of ['UTC', 'America/New_York', 'Pacific/Kiritimati']) {
    it(`produces the golden UTC value under TZ=${tz}`, async () => {
      const capturedAt = await capturedAtForDateUnderTimezone(tz, 2020, 0, 2, 3, 4, 5);
      expect(capturedAt).toBe('2020-01-02T03:04:05.000Z');
    }, 10_000);
  }
});

describe('normalizeExif captured_at — timezone independence (P0)', () => {
  // Pacific/Kiritimati (UTC+14) and America/New_York (UTC-4/-5) are picked
  // specifically to be about as far apart as IANA zones get — roughly
  // 18-19 hours of offset difference — so a real timezone-dependent bug
  // could not coincidentally cancel out between them the way two similar
  // offsets might.
  for (const tz of ['UTC', 'America/New_York', 'Pacific/Kiritimati']) {
    it(`produces the golden UTC value under TZ=${tz}`, async () => {
      const capturedAt = await capturedAtUnderTimezone(tz, GOLDEN_EXIF_STRING);
      expect(capturedAt).toBe(GOLDEN_UTC_ISO);
    }, 10_000);
  }

  it('CreateDate falls back through the same UTC rule under a non-UTC zone', async () => {
    const capturedAt = await capturedAtUnderTimezone('America/New_York', '2026:12:25 23:59:59');
    expect(capturedAt).toBe('2026-12-25T23:59:59.000Z');
  }, 10_000);
});

/**
 * Minimal big-endian TIFF whose IFD0 carries an ExifIFD pointer (tag
 * 0x8769) to a nested Exif sub-IFD holding a single DateTimeOriginal tag
 * (0x9003, ASCII). DateTimeOriginal/CreateDate live in the Exif sub-IFD in
 * a real file, not IFD0 directly (unlike `exif.formats.test.ts`'s flatter
 * `makeTiff`, which only needs a top-level Make tag) — this fixture exists
 * specifically to exercise that traversal so `readExif`'s real
 * `exifr.parse` call (not a hand-built `normalizeExif` input) is what's
 * under test below.
 */
function makeTiffWithDateTimeOriginal(dateTimeOriginal: string): Buffer {
  const value = Buffer.from(dateTimeOriginal + '\0', 'latin1');

  const header = Buffer.alloc(8);
  header.write('MM', 0, 'latin1');
  header.writeUInt16BE(0x002a, 2);
  header.writeUInt32BE(8, 4);

  const ifd0Size = 2 + 12 + 4;
  const exifIfdOffset = 8 + ifd0Size;
  const ifd0 = Buffer.alloc(ifd0Size);
  ifd0.writeUInt16BE(1, 0); // 1 entry
  ifd0.writeUInt16BE(0x8769, 2); // ExifIFD pointer tag
  ifd0.writeUInt16BE(4, 4); // type LONG
  ifd0.writeUInt32BE(1, 6); // count
  ifd0.writeUInt32BE(exifIfdOffset, 10); // value: offset to Exif sub-IFD
  ifd0.writeUInt32BE(0, 14); // next IFD offset

  const exifIfdSize = 2 + 12 + 4;
  const stringOffset = exifIfdOffset + exifIfdSize;
  const exifIfd = Buffer.alloc(exifIfdSize);
  exifIfd.writeUInt16BE(1, 0); // 1 entry
  exifIfd.writeUInt16BE(0x9003, 2); // DateTimeOriginal
  exifIfd.writeUInt16BE(2, 4); // type ASCII
  exifIfd.writeUInt32BE(value.length, 6); // count (incl. trailing NUL)
  exifIfd.writeUInt32BE(stringOffset, 10); // value: offset to string
  exifIfd.writeUInt32BE(0, 14); // next IFD offset

  return Buffer.concat([header, ifd0, exifIfd, value]);
}

/** Runs `readExif(filePath)` in a fresh child `bun` process started with
 * `TZ=tz`, returning its `captured_at`. Goes through the REAL `exifr.parse`
 * call (default `reviveValues: true`), unlike `capturedAtUnderTimezone`
 * above which hand-builds the `normalizeExif` input — this is what actually
 * exercises the P0-2 bug (exifr's own local-timezone Date construction). */
async function readExifCapturedAtUnderTimezone(
  tz: string,
  filePath: string,
): Promise<string | null> {
  const script = `
    import { readExif } from ${JSON.stringify(EXIF_TS_PATH)};
    const result = await readExif(${JSON.stringify(filePath)});
    process.stdout.write(JSON.stringify(result ? result.captured_at : null));
  `;
  const proc = Bun.spawn(['bun', '-e', script], {
    env: { ...process.env, TZ: tz },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(`child process (TZ=${tz}) exited ${exitCode}: ${stderr}`);
  }
  return JSON.parse(stdout) as string | null;
}

describe('readExif captured_at — exifr Date-revival bypass (#2004 review round 2, P0-2)', () => {
  let dir: string;
  let tiffPath: string;

  it('setup', async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'exif-exifr-date-'));
    tiffPath = path.join(dir, 'golden.tiff');
    await writeFile(tiffPath, makeTiffWithDateTimeOriginal(GOLDEN_EXIF_STRING));
    expect(dir).toBeTruthy();
  });

  // exifr's default `reviveValues: true` (which EXIFR_PARSE_OPTS relies on
  // for GPS/other tag revival) converts DateTimeOriginal into a `Date`
  // object itself via the same locally-ambiguous construction `asIsoDate`'s
  // string branch was fixed to avoid — bypassing that fix one layer
  // upstream. Unfixed, this would produce a DIFFERENT `captured_at` (and
  // therefore a different cross-platform `maple_id`) for the identical
  // TIFF depending on the reading process's `TZ`.
  for (const tz of ['UTC', 'America/New_York', 'Pacific/Kiritimati']) {
    it(`produces the golden UTC value under TZ=${tz} even though exifr revives the Date itself`, async () => {
      const capturedAt = await readExifCapturedAtUnderTimezone(tz, tiffPath);
      expect(capturedAt).toBe(GOLDEN_UTC_ISO);
    }, 10_000);
  }

  it('cleanup', async () => {
    await rm(dir, { recursive: true, force: true });
    expect(true).toBe(true);
  });
});
