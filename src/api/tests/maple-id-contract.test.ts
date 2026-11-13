import { test, expect } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdtemp, writeFile, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';
import vectors from '../../../test-fixtures/ids/parser.json';
import * as api from '../src/indexer/id.ts';
import { readExif } from '../src/indexer/exif.ts';
import { VIDEO_EXTS } from '../src/indexer/media-types.ts';
import { asIsoDate } from '../../web/projects/maple-common/src/lib/addressing/captured-at.ts';
import {
  blobReader,
  readRawCaptureDates,
} from '../../web/projects/maple-common/src/lib/addressing/exif-capture-dates.ts';
import { videoCaptureDate } from '../../web/projects/maple-common/src/lib/addressing/video-capture-date.ts';
import * as web from '../../web/projects/maple-common/src/lib/addressing/maple-id-parser.ts';
import { MAPLE_ID_DERIVATION_VERSION } from '../src/generated/maple-id-derivation-version.generated.ts';

for (const [name, implementation] of Object.entries({ api, web })) {
  test(`${name}: shared parser contract`, () => {
    for (const value of vectors.valid) {
      const id = implementation.fromHex(value);
      expect(id.hex).toBe(value.toLowerCase());
      expect(Buffer.from(id.bytes).toString('hex')).toBe(id.hex);
    }
    for (const value of vectors.invalid) expect(() => implementation.fromHex(value)).toThrow();
  });
}

test('maple_id derivation version is single-sourced from raw-core', () => {
  expect(MAPLE_ID_DERIVATION_VERSION).toBe(3);
});

test('70,001-byte golden preserves primary and the full-file fallback on the server, browser and native paths', async () => {
  const bytes = Uint8Array.from({ length: 70001 }, (_, i) => i % 251);
  expect(api.primary(bytes, '2024:06:01 12:34:56', 'SN-1234', 4242).hex).toBe(
    '01102ecbacd47a8405c6ed25cac58f85',
  );
  expect(api.fallback(bytes, bytes.length).hex).toBe('020cd7e09e4485130fa4e571188060f1');
  const dir = await mkdtemp(join(tmpdir(), 'maple-id-golden-'));
  try {
    const file = join(dir, 'original.bin');
    await writeFile(file, bytes);
    expect((await api.hashFileForId(file)).maple_id).toBe('020cd7e09e4485130fa4e571188060f1');
    expect(new Uint8Array(await readFile(file))).toEqual(bytes);
  } finally {
    await rm(dir, { recursive: true });
  }
});

// The shared derivation corpus (#5079): the server's reader, the web port and
// every device client must agree on each file's capture date and id. The Swift
// (MapleIdDerivationContractTests), raw-core (maple_id_derivation_corpus.rs) and web
// (maple-id-derivation-contract.spec.ts) suites pin the same `derivation.json`.
const derivation = JSON.parse(
  await readFile(new URL('../../../test-fixtures/ids/derivation.json', import.meta.url), 'utf8'),
) as { cases: { file: string; capturedAt: string | null; id: string; optional?: boolean }[] };

for (const { file, capturedAt, id, optional } of derivation.cases) {
  const path = new URL(`../../../test-fixtures/ids/${file}`, import.meta.url).pathname;
  const present = existsSync(path);
  const run = optional && !present ? test.skip : test;

  run(`derivation corpus: the server dates and hashes ${file}`, async () => {
    expect((await readExif(path))?.captured_at ?? null).toBe(capturedAt);
    // The primary form hashes only the first 64 KB; the fallback form (committed
    // fixtures only) the whole file.
    const bytes = new Uint8Array(await Bun.file(path).slice(0, api.SHA1_HEAD_BYTES).arrayBuffer());
    const derived =
      capturedAt === null
        ? api.fallback(new Uint8Array(await readFile(path)), (await stat(path)).size)
        : api.primary(bytes, capturedAt, null, null);
    expect(derived.hex).toBe(id);
  });

  if (VIDEO_EXTS.has(extname(file))) {
    run(`derivation corpus: the web moov reader dates ${file} as the server does`, async () => {
      expect(await videoCaptureDate(Bun.file(path))).toBe(capturedAt);
    });
  } else {
    run(`derivation corpus: the shared tag reader dates ${file} as the server does`, async () => {
      const dates = await readRawCaptureDates(blobReader(Bun.file(path)));
      expect(dates).not.toBeNull();
      expect(asIsoDate(dates?.DateTimeOriginal) ?? asIsoDate(dates?.CreateDate) ?? null, file).toBe(
        capturedAt,
      );
    });
  }
}
