#!/usr/bin/env node
/**
 * Node-22 acceptance smoke test for @justmaple/maple (#3509).
 *
 * This is deliberately NOT a `bun:test` file. This repo's whole test suite
 * (`test/*.test.ts`) is written against `import { describe, expect, it }
 * from 'bun:test'`, which has no Node-native equivalent runner — running
 * those files with plain `node` fails immediately on that import, before a
 * single assertion executes. A real "this package works under Node" proof
 * therefore has to be a standalone script with zero `bun:test` (or any
 * other Bun-only) dependency, executed with a bare `node script.mjs` — this
 * is that script.
 *
 * It exercises the package's actual published entry point (`dist/index.js`,
 * loaded here exactly as a real consumer's `import '@justmaple/maple'`
 * would resolve it) against the real handful of operations most likely to
 * expose "the napi addon didn't wire up right for this specific call":
 *
 *   1. `validateFilename` — synchronous, no native library beyond the addon
 *      itself, exercises the plain pass/fail path.
 *   2. `renderFilenameTemplate` — synchronous, exercises structured
 *      argument marshalling (the `capturedAt: string | null` napi-object
 *      quirk documented in `native-napi.ts`).
 *   3. `maple(...).resize(...).png().toBuffer()` — the real `callNative` →
 *      napi dispatch path, through the actual public `maple()` builder API,
 *      against the git-tracked calibration PNG
 *      (`src/apple/MapleUITests/Goldens/.calibration/a.png`). This check is
 *      UNCONDITIONAL — no fixture gating — so it is the one that actually
 *      runs on every real CI invocation and proves the napi dispatch path
 *      works under Node, rather than silently no-op'ing on a runner with no
 *      gitignored RAW fixtures.
 *   4. `maple(...).format(...).toBuffer()` — the actual RAW-development
 *      pipeline end to end: decode a real 100MP DNG, develop it, encode a
 *      real JPEG, and hand back real bytes. This is the literal thing
 *      ticket #3509 exists to prove works under Node with zero Bun
 *      involved, as an extra proof on top of check 3 above. Runs only when
 *      the (gitignored) reference RAW fixture is resolvable — same "skip
 *      when fixtures aren't present" convention the Rust color-pipeline
 *      harnesses use (`src/scripts/test_color_pipeline.sh` et al.), since
 *      `test-fixtures/raws/` is not checked into git and a CI runner has no
 *      reason to have it locally.
 *
 * Every check below asserts a REAL, EXACT expected value (a specific
 * filename, a specific `{ ok, ... }` shape, a plausible non-zero byte
 * count) — never just "the call didn't throw" — because a napi/JS
 * argument-marshalling bug can easily produce a wrong-but-truthy result
 * (see native-napi.ts's own module doc for two such bugs Task 7 found and
 * fixed empirically the same way).
 *
 * Exit code: 0 if every check that ran passed. Non-zero with a clear
 * message identifying which check failed and why, otherwise.
 */

import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(here, '..');
const distEntry = path.join(packageRoot, 'dist', 'index.js');
const repoRoot = path.resolve(packageRoot, '..', '..');
const fixtureDng = path.join(repoRoot, 'test-fixtures', 'raws', 'dji-mavic3pro-100mp.dng');
// Git-tracked (unlike test-fixtures/raws/), so this is always present —
// the calibration fixture the Swift CIEDE2000 harness also relies on
// (src/apple/MapleUITests/Helpers/CIEDE2000Tests). Used below for the one
// napi-dispatch check that must run unconditionally on every CI invocation.
const calibrationPng = path.join(
  repoRoot,
  'src',
  'apple',
  'MapleUITests',
  'Goldens',
  '.calibration',
  'a.png',
);

/** Tiny assertion helper — throws a descriptive `Error` on mismatch rather
 *  than relying on a test framework (none is available/appropriate here). */
function assertEqual(actual, expected, label) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    throw new Error(`${label}: expected ${e}, got ${a}`);
  }
}

function assert(condition, label) {
  if (!condition) {
    throw new Error(`${label}: assertion failed`);
  }
}

async function main() {
  console.log(`node ${process.version} on ${process.platform}-${process.arch}`);
  console.log(`Bun global present: ${typeof globalThis.Bun !== 'undefined'}`);

  if (!existsSync(distEntry)) {
    throw new Error(
      `dist entry point not found at ${distEntry} — run "bun run build" in src/maple first.`,
    );
  }

  const { maple, validateFilename, renderFilenameTemplate } = await import(distEntry);

  // 1. validateFilename — plain valid name.
  const validResult = validateFilename('ok.jpg');
  assertEqual(validResult, { ok: true }, 'validateFilename("ok.jpg")');
  console.log('PASS validateFilename("ok.jpg") ->', JSON.stringify(validResult));

  // 2. validateFilename — rejects a path separator, with a real {code,error} shape.
  const invalidResult = validateFilename('bad/name.jpg');
  assert(invalidResult.ok === false, 'validateFilename("bad/name.jpg").ok must be false');
  assert(
    typeof invalidResult.code === 'number',
    'validateFilename("bad/name.jpg").code must be a number',
  );
  assert(
    typeof invalidResult.error === 'string' && invalidResult.error.length > 0,
    'validateFilename("bad/name.jpg").error must be a non-empty string',
  );
  console.log('PASS validateFilename("bad/name.jpg") ->', JSON.stringify(invalidResult));

  // 3. renderFilenameTemplate — exact expected rendered name (matches README.md's own example).
  const nameResult = renderFilenameTemplate({
    template: '{original}_{n}.{ext}',
    originalStem: 'DSC_0001',
    ext: 'jpg',
    capturedAt: '2026:09:09 14:30:00',
    sequenceStart: 1,
    sequenceIndex: 0,
    sequencePadWidth: 4,
  });
  assertEqual(nameResult, { ok: true, name: 'DSC_0001_0001.jpg' }, 'renderFilenameTemplate(...)');
  console.log('PASS renderFilenameTemplate(...) ->', JSON.stringify(nameResult));

  // 4. renderFilenameTemplate — a null capturedAt must not throw (napi-object null/undefined quirk).
  const nullDateResult = renderFilenameTemplate({
    template: '{original}.{ext}',
    originalStem: 'IMG_0002',
    ext: 'dng',
    capturedAt: null,
    sequenceStart: 1,
    sequenceIndex: 0,
    sequencePadWidth: 3,
  });
  assertEqual(
    nullDateResult,
    { ok: true, name: 'IMG_0002.dng' },
    'renderFilenameTemplate(capturedAt: null)',
  );
  console.log('PASS renderFilenameTemplate(capturedAt: null) ->', JSON.stringify(nullDateResult));

  // 5. maple(...).resize(...).png().toBuffer() against the git-tracked
  //    calibration PNG — UNCONDITIONAL, no fixture gating. validateFilename
  //    and renderFilenameTemplate above are synchronous and never touch
  //    `callNative`; this is the one check that actually exercises the real
  //    `callNative` -> napi -> `rasterPipelineBuf` dispatch path, through
  //    the public `maple()` builder API, on every real CI invocation —
  //    regardless of whether the gitignored RAW fixtures used by check 6
  //    below are present.
  if (!existsSync(calibrationPng)) {
    throw new Error(
      `calibration fixture not found at ${calibrationPng} — this file is git-tracked ` +
        'and must always be present; something is wrong with the checkout, not the fixture set.',
    );
  }
  const calibrationBuf = await maple(calibrationPng).resize(32, 32).png().toBuffer();
  assert(
    Buffer.isBuffer(calibrationBuf),
    'maple(...).resize(32, 32).png().toBuffer() must resolve to a Buffer',
  );
  // Exact, reproducible byte count for this fixture at this size/format —
  // not just "> 0" — so a napi argument-marshalling bug that produces a
  // wrong-but-truthy buffer (see native-napi.ts's own module doc) is caught.
  assertEqual(calibrationBuf.length, 193, 'maple(...).resize(32, 32).png().toBuffer() byte length');
  // A real PNG starts with the 8-byte PNG signature; check the leading
  // magic bytes (0x89 0x50 0x4E 0x47 = "\x89PNG").
  assert(
    calibrationBuf[0] === 0x89 &&
      calibrationBuf[1] === 0x50 &&
      calibrationBuf[2] === 0x4e &&
      calibrationBuf[3] === 0x47,
    'maple(...).resize(32, 32).png().toBuffer() must produce a real PNG (magic bytes), got ' +
      `${calibrationBuf[0]?.toString(16)} ${calibrationBuf[1]?.toString(16)} ` +
      `${calibrationBuf[2]?.toString(16)} ${calibrationBuf[3]?.toString(16)}`,
  );
  console.log(
    `PASS maple(...).resize(32, 32).png().toBuffer() -> ${calibrationBuf.length} bytes, real PNG (napi dispatch path)`,
  );

  // 6. The real RAW-development pipeline end to end, when the (gitignored)
  //    reference fixture is resolvable.
  if (!existsSync(fixtureDng)) {
    console.log(
      `SKIP real RAW decode: fixture not found at ${fixtureDng} ` +
        '(test-fixtures/raws/ is gitignored and not expected on a bare CI checkout).',
    );
  } else {
    const buf = await maple(fixtureDng).format('jpeg').quality(80).toBuffer();
    assert(Buffer.isBuffer(buf), 'maple(...).toBuffer() must resolve to a Buffer');
    // A real developed+encoded JPEG from a 100MP RAW is comfortably in the
    // megabytes; anything near-zero means the pipeline produced garbage
    // (or an empty/error buffer) rather than a real image.
    assert(
      buf.length > 100_000,
      `maple(...).toBuffer() byte length must be plausible for a real JPEG, got ${buf.length}`,
    );
    // A real JPEG starts with the SOI marker (0xFFD8).
    assert(
      buf[0] === 0xff && buf[1] === 0xd8,
      `maple(...).toBuffer() must produce a real JPEG (SOI marker), got bytes ${buf[0]?.toString(16)} ${buf[1]?.toString(16)}`,
    );
    console.log(`PASS maple(...).format('jpeg').toBuffer() -> ${buf.length} bytes, real JPEG`);
  }

  console.log('\nAll Node smoke-test checks passed.');
}

main().catch((err) => {
  console.error('\nFAILED Node smoke test:', err);
  process.exitCode = 1;
});
