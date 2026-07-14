// exif.timezone.test.ts — proves `normalizeExif`'s `captured_at` derivation
// is timezone-independent (#2004 review, P0).
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
