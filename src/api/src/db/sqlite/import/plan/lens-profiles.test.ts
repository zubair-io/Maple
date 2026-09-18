/**
 * Reassembling a GridFS lens profile, which is the one import that can fail
 * silently.
 *
 * Every other plan maps a document to a row: if a field is wrong the value is
 * visibly wrong. Here the destination is a hash-addressed blob, so chunks put
 * back together in the wrong order produce a file of exactly the right length
 * whose contents are garbage — nothing in the import notices, and the operator
 * finds out when a photo that uses the profile renders differently, long after
 * the source database is gone.
 *
 * So these cases are about ordering and about refusal. A single-chunk profile
 * would pass whether or not the ordering is right, which is why every case here
 * spans several chunks.
 *
 * Driven against a stub `Db` rather than a real MongoDB: the reassembly is the
 * thing under test and it is pure once the chunks are in hand, so requiring a
 * server would only mean this skip-passes on a machine that has none — and a
 * skip is not evidence.
 */

import { describe, expect, test } from 'bun:test';
import { blake3 } from '@noble/hashes/blake3.js';
import type { Db } from 'mongodb';
import { lensProfilesPlan } from './lens-profiles.ts';
import { IMPORT_PLAN, uncoveredCollections } from './index.ts';
import type { MapContext } from '../types.ts';

const CTX: MapContext = { stageNames: [], note: () => {} };

function digestOf(bytes: Uint8Array): string {
  return Buffer.from(blake3(bytes)).toString('hex');
}

interface Chunk {
  files_id: unknown;
  n: number;
  data: Uint8Array;
}

/** What `find(...).toArray()` will hand back, and what it was asked for. */
interface StubCall {
  filter: unknown;
  options: unknown;
}

/**
 * A `Db` that answers exactly the one query the plan makes.
 *
 * `served` decides what comes back, so a case can simulate a driver that
 * ignored the sort — which is the whole failure mode under test.
 */
function stubDb(served: (chunks: Chunk[]) => Chunk[], chunks: Chunk[]) {
  const calls: StubCall[] = [];
  const db = {
    collection(name: string) {
      expect(name).toBe('lens_profiles.chunks');
      return {
        find(filter: unknown, options: unknown) {
          calls.push({ filter, options });
          return { toArray: async () => served(chunks) };
        },
      };
    },
  } as unknown as Db;
  return { db, calls };
}

/** Splits `bytes` into GridFS-style chunks of `size`. */
function chunked(filesId: string, bytes: Uint8Array, size: number): Chunk[] {
  const out: Chunk[] = [];
  for (let offset = 0, n = 0; offset < bytes.length; offset += size, n++) {
    out.push({ files_id: filesId, n, data: bytes.slice(offset, offset + size) });
  }
  return out;
}

/**
 * Deterministic pseudo-random bytes, from a linear congruential generator
 * rather than a formula in `i`.
 *
 * This matters more than it looks. The first version of this fixture used
 * `(i * 17 + 5) % 256`, which repeats every 256 bytes — and since a GridFS
 * chunk is a whole multiple of 256, every full chunk held identical content and
 * swapping two of them changed nothing. The out-of-order case passed the
 * corruption straight through and the test failed for the right reason. A
 * sequence with no period shorter than the file is what makes "the chunks were
 * reordered" observable at all.
 */
function profileBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  let state = 0x2545f491;
  for (let i = 0; i < length; i++) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    bytes[i] = (state >>> 24) & 0xff;
  }
  return bytes;
}

async function hydrateOne(db: Db, doc: Record<string, unknown>): Promise<Record<string, unknown>> {
  const hydrated = await lensProfilesPlan.hydrate!(db, [doc]);
  return hydrated[0]!;
}

describe('the lens-profile bucket', () => {
  const bytes = profileBytes(255 * 1024 * 3 + 91); // four chunks, last one short
  const digest = digestOf(bytes);
  const chunks = chunked('file-1', bytes, 255 * 1024);

  function fileDoc(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      _id: 'file-1',
      filename: digest,
      length: bytes.length,
      metadata: { version: 1, reference: `lcp1:${digest}`, lens: 'Prime' },
      ...overrides,
    };
  }

  test('puts a multi-chunk profile back together byte for byte', async () => {
    expect(chunks.length).toBe(4);
    const { db } = stubDb((c) => c, chunks);

    const rows = lensProfilesPlan.map(await hydrateOne(db, fileDoc()), CTX);

    expect(rows).toHaveLength(1);
    expect(rows[0]!.table).toBe('lens_profiles');
    expect(rows[0]!.columns).toEqual(['digest', 'bytes', 'inventory']);
    const [storedDigest, storedBytes, inventory] = rows[0]!.rows[0]!;
    expect(storedDigest).toBe(digest);
    expect(Buffer.from(storedBytes as Uint8Array).equals(Buffer.from(bytes))).toBe(true);
    expect(JSON.parse(inventory as string)).toEqual({
      version: 1,
      reference: `lcp1:${digest}`,
      lens: 'Prime',
    });
  });

  /**
   * The sort is the only thing standing between a correct import and a
   * silently corrupt one, and MongoDB guarantees no order without it.
   */
  test('asks the driver for the chunks in file-then-index order', async () => {
    const { db, calls } = stubDb((c) => c, chunks);

    await hydrateOne(db, fileDoc());

    expect(calls).toHaveLength(1);
    expect(calls[0]!.options).toMatchObject({ sort: { files_id: 1, n: 1 } });
  });

  test('refuses chunks that came back out of order rather than storing them', async () => {
    // Same bytes, same length, wrong order — the exact shape of the corruption
    // that has no other symptom.
    const { db } = stubDb((c) => [c[1]!, c[0]!, c[2]!, c[3]!], chunks);
    const doc = await hydrateOne(db, fileDoc());

    expect(() => lensProfilesPlan.map(doc, CTX)).toThrow(/hash to/);
  });

  test('refuses a profile whose reassembled length disagrees with the bucket', async () => {
    const { db } = stubDb((c) => c.slice(0, 2), chunks);
    const doc = await hydrateOne(db, fileDoc());

    expect(() => lensProfilesPlan.map(doc, CTX)).toThrow(/declares/);
  });

  test('refuses a file whose chunks are missing entirely', async () => {
    const { db } = stubDb(() => [], chunks);
    const doc = await hydrateOne(db, fileDoc());

    expect(() => lensProfilesPlan.map(doc, CTX)).toThrow(/unrecoverable/);
  });

  test('refuses a file whose name is not a digest', async () => {
    const { db } = stubDb((c) => c, chunks);
    const doc = await hydrateOne(db, fileDoc({ filename: 'profile.lcp' }));

    expect(() => lensProfilesPlan.map(doc, CTX)).toThrow(/64-character hex/);
  });

  test('stores an empty inventory when the bucket carried no metadata', async () => {
    const { db } = stubDb((c) => c, chunks);
    const doc = await hydrateOne(db, fileDoc({ metadata: undefined }));

    const rows = lensProfilesPlan.map(doc, CTX);
    expect(JSON.parse(rows[0]!.rows[0]![2] as string)).toEqual({});
  });

  test('keeps each file to its own bytes when a batch carries several', async () => {
    const otherBytes = profileBytes(700 * 1024);
    const otherDigest = digestOf(otherBytes);
    const both = [...chunks, ...chunked('file-2', otherBytes, 255 * 1024)];
    const { db } = stubDb((c) => c, both);

    const hydrated = await lensProfilesPlan.hydrate!(db, [
      fileDoc(),
      {
        _id: 'file-2',
        filename: otherDigest,
        length: otherBytes.length,
        metadata: {},
      },
    ]);

    const first = lensProfilesPlan.map(hydrated[0]!, CTX)[0]!.rows[0]!;
    const second = lensProfilesPlan.map(hydrated[1]!, CTX)[0]!.rows[0]!;
    expect(first[0]).toBe(digest);
    expect(second[0]).toBe(otherDigest);
    expect((second[1] as Uint8Array).length).toBe(otherBytes.length);
  });
});

/**
 * The coverage guard is what decides whether a real install boots at all: it
 * reads the source database and refuses to start on any collection the plan
 * neither imports nor declares skipped. Before the lens-profile plan existed,
 * both GridFS collections were in neither list, so the boot migration aborted
 * on every install that had ever imported a profile.
 */
describe('coverage', () => {
  /** A `Db` that reports exactly these collection names. */
  function dbWithCollections(names: readonly string[]): Db {
    return {
      listCollections: () => ({ toArray: async () => names.map((name) => ({ name })) }),
    } as unknown as Db;
  }

  test('declares both GridFS collections so neither has to be called skipped', () => {
    expect(lensProfilesPlan.source).toBe('lens_profiles.files');
    expect(lensProfilesPlan.alsoReads).toEqual(['lens_profiles.chunks']);
  });

  test('treats the chunks collection as covered, not as an unknown one', async () => {
    const db = dbWithCollections(['lens_profiles.files', 'lens_profiles.chunks']);
    expect(await uncoveredCollections(db, [lensProfilesPlan])).toEqual([]);
  });

  test('still reports a collection nothing claims', async () => {
    const db = dbWithCollections(['lens_profiles.files', 'something_new']);
    expect(await uncoveredCollections(db, [lensProfilesPlan])).toEqual(['something_new']);
  });

  test('the real plan covers both of them', async () => {
    const db = dbWithCollections(['lens_profiles.files', 'lens_profiles.chunks']);
    expect(await uncoveredCollections(db, IMPORT_PLAN)).toEqual([]);
  });
});
