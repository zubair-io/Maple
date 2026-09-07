/** Durable imported bytes; GridFS also supports profiles above Mongo's 16 MiB document limit. */
import { GridFSBucket } from 'mongodb';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { blake3 } from '@noble/hashes/blake3.js';
import { getDb } from '../db/client.ts';
import { lensProfileDigest, MAX_LCP_BYTES, type LensProfileInventory } from './types.ts';

async function bucket(): Promise<GridFSBucket> {
  return new GridFSBucket(await getDb(), { bucketName: 'lens_profiles' });
}

export async function saveLensProfile(
  bytes: Uint8Array,
  inventory: LensProfileInventory,
): Promise<void> {
  if (!bytes.length || bytes.length > MAX_LCP_BYTES)
    throw new Error('LCP must be between 1 byte and 32 MiB');
  const digest = lensProfileDigest(inventory.reference);
  verifyDigest(bytes, digest);
  const store = await bucket();
  if (await store.find({ filename: digest }).limit(1).next()) return;
  const upload = store.openUploadStream(digest, { metadata: inventory });
  try {
    await pipeline(Readable.from([bytes]), upload);
  } catch (error) {
    await upload.abort().catch(() => {});
    throw error;
  }
}

export async function loadLensProfile(digest: string): Promise<Uint8Array | null> {
  lensProfileDigest(`lcp1:${digest}`);
  const store = await bucket();
  const file = await store.find({ filename: digest }).limit(1).next();
  if (!file) return null;
  if (file.length <= 0 || file.length > MAX_LCP_BYTES)
    throw new Error('Stored LCP has an invalid size');
  const stream = store.openDownloadStream(file._id);
  const chunks: Buffer[] = [];
  let length = 0;
  try {
    for await (const chunk of stream) {
      length += chunk.length;
      if (length > MAX_LCP_BYTES) throw new Error('Stored LCP exceeds 32 MiB');
      chunks.push(chunk);
    }
  } finally {
    stream.destroy();
  }
  if (length !== file.length) throw new Error('Stored LCP is incomplete');
  const bytes = Buffer.concat(chunks, length);
  verifyDigest(bytes, digest);
  return bytes;
}

function verifyDigest(bytes: Uint8Array, digest: string): void {
  if (Buffer.from(blake3(bytes)).toString('hex') !== digest) {
    throw new Error('LCP contents do not match the authored content digest');
  }
}
