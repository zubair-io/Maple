/**
 * The lens-profile GridFS bucket, reassembled into one row per profile.
 *
 * This is the only plan that reads two source collections. GridFS stores a file
 * as one document in `lens_profiles.files` (length, filename, metadata) plus N
 * documents in `lens_profiles.chunks`, each carrying a slice of the bytes and
 * its position in the file. The destination table holds the whole file in a
 * single BLOB, so the import has to put the slices back together.
 *
 * ## What is at stake if the order is wrong
 *
 * A profile is named, in every XMP sidecar that selects it, by the BLAKE3 hash
 * of its own bytes. Chunks concatenated in the wrong order produce a file of
 * exactly the right length that hashes to something else — so nothing would fail
 * at import, `lens-profiles/cache.ts` would reject the blob at read time, and
 * the operator would discover it the first time someone opened an affected photo
 * in the editor, long after the source database was gone.
 *
 * MongoDB returns documents in no guaranteed order without a sort, and the
 * natural insertion order is not something to rely on across a dump and restore.
 * So {@link hydrate} sorts explicitly on `n`, and {@link map} re-hashes the
 * result and refuses to write a row whose bytes do not hash to their own
 * filename. That refusal becomes a reject, verification treats any reject as a
 * failure, and `migrateAtBoot` turns a failed verification into a refusal to
 * serve — which is the outcome we want. A migration that stops is recoverable;
 * a library that quietly lost a profile is not.
 *
 * ## Why the bytes are gathered per batch rather than per document
 *
 * One `find` over every chunk belonging to the batch's files, grouped in memory,
 * rather than one query per file. Profiles are few and large, so the batch is
 * bounded by bytes rather than by document count — but the query count still
 * matters on a slow link, and the grouping is the same work either way.
 */

import { Binary, type Db, type Document, type Filter } from 'mongodb';
import { blake3 } from '@noble/hashes/blake3.js';
import type { CollectionPlan, Row, TableRows } from '../types.ts';

const FILES = 'lens_profiles.files';
const CHUNKS = 'lens_profiles.chunks';

/** Where {@link hydrate} leaves the assembled bytes for {@link map}. */
const BYTES_KEY = '__bytes';

const COLUMNS = ['digest', 'bytes', 'inventory'] as const;

/** One chunk as GridFS stores it: the file it belongs to, its index, its slice. */
interface ChunkDoc {
  files_id: unknown;
  n: number;
  data: Binary | Uint8Array;
}

function chunkBytes(data: ChunkDoc['data']): Uint8Array {
  // The driver hands BSON binary back as `Binary`; a fixture inserted from a
  // plain Uint8Array round-trips as one too, but not every path does.
  return data instanceof Binary ? new Uint8Array(data.buffer) : new Uint8Array(data);
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/**
 * Every chunk of the given files, in file order then chunk order.
 *
 * The sort is on `(files_id, n)`, which is the index GridFS creates, so this is
 * a scan of exactly the rows wanted and no in-memory sort.
 */
async function gatherChunks(db: Db, fileIds: readonly unknown[]): Promise<Map<string, Uint8Array>> {
  const chunks = await db
    .collection<ChunkDoc>(CHUNKS)
    .find({ files_id: { $in: fileIds as never[] } }, { sort: { files_id: 1, n: 1 } })
    .toArray();

  const parts = new Map<string, Uint8Array[]>();
  for (const chunk of chunks) {
    const key = String(chunk.files_id);
    const list = parts.get(key);
    if (list === undefined) parts.set(key, [chunkBytes(chunk.data)]);
    else list.push(chunkBytes(chunk.data));
  }

  const assembled = new Map<string, Uint8Array>();
  for (const [key, list] of parts) assembled.set(key, concat(list));
  return assembled;
}

function digestOf(bytes: Uint8Array): string {
  return Buffer.from(blake3(bytes)).toString('hex');
}

/**
 * The filename GridFS stored, which is the profile's digest and becomes its
 * primary key.
 */
function storedDigest(doc: Record<string, unknown>): string {
  const filename = doc.filename;
  if (typeof filename !== 'string' || !/^[0-9a-f]{64}$/.test(filename)) {
    throw new Error(`filename: expected a 64-character hex digest, got ${String(filename)}`);
  }
  return filename;
}

function values(doc: Record<string, unknown>): Row {
  const digest = storedDigest(doc);
  const bytes = doc[BYTES_KEY];
  if (!(bytes instanceof Uint8Array) || bytes.length === 0) {
    throw new Error(`${digest}: no chunks found for this profile, so its bytes are unrecoverable`);
  }

  // `length` is GridFS's own record of the file size. Checking it first tells a
  // truncated read apart from a misordered one in the reject message.
  const declared = doc.length;
  if (typeof declared === 'number' && declared !== bytes.length) {
    throw new Error(
      `${digest}: reassembled ${bytes.length} bytes but the bucket declares ${declared}`,
    );
  }

  const actual = digestOf(bytes);
  if (actual !== digest) {
    throw new Error(
      `${digest}: reassembled bytes hash to ${actual}. The chunks did not go back together ` +
        'correctly, and writing this row would store a profile that renders different pixels ' +
        'than the one the sidecars reference.',
    );
  }

  return [digest, bytes, JSON.stringify(doc.metadata ?? {})];
}

export const lensProfilesPlan: CollectionPlan = {
  source: FILES,
  alsoReads: [CHUNKS],
  tables: ['lens_profiles'],
  idKind: 'objectid',

  async hydrate(db, docs): Promise<Record<string, unknown>[]> {
    const assembled = await gatherChunks(
      db,
      docs.map((doc) => doc._id),
    );
    return docs.map((doc) => ({ ...doc, [BYTES_KEY]: assembled.get(String(doc._id)) }));
  },

  map(doc): TableRows[] {
    return [{ table: 'lens_profiles', columns: COLUMNS, rows: [values(doc)] }];
  },

  async expected(db: Db, filter: Filter<Document>): Promise<Record<string, number>> {
    return { lens_profiles: await db.collection(FILES).countDocuments(filter) };
  },
};
