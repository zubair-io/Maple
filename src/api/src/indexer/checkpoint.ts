/**
 * Per-folder indexer checkpoint.
 *
 * Stored in a dedicated Mongo collection so an indexer restart can
 * resume: re-walk folders whose on-disk mtime has advanced past our
 * last recorded walk, and re-enqueue jobs that were in flight when
 * we went down.
 */

import { getDb } from "../db/client.ts";
import type { Collection } from "mongodb";

export interface CheckpointDoc {
  /** Hex string of the folder's Mongo ObjectId. */
  folderId: string;
  /** Absolute filesystem path — handy for cross-checks / orphan cleanup. */
  path: string;
  /** Most recent time we finished a full walk (ms since epoch). */
  lastWalkedAt: number;
  /** maple:id hex strings of jobs that had been picked up but not finished. */
  inflightIds: string[];
  updatedAt: number;
}

export async function checkpointsCollection(): Promise<Collection<CheckpointDoc>> {
  const db = await getDb();
  const coll = db.collection<CheckpointDoc>("indexer_checkpoints");
  return coll;
}

export async function ensureCheckpointIndexes(): Promise<void> {
  const coll = await checkpointsCollection();
  await coll.createIndex({ folderId: 1 }, { unique: true });
}

export async function readCheckpoint(folderId: string): Promise<CheckpointDoc | null> {
  const coll = await checkpointsCollection();
  return coll.findOne({ folderId });
}

export async function writeCheckpoint(doc: CheckpointDoc): Promise<void> {
  const coll = await checkpointsCollection();
  await coll.updateOne(
    { folderId: doc.folderId },
    { $set: { ...doc, updatedAt: Date.now() } },
    { upsert: true }
  );
}

export async function markInflight(folderId: string, id: string): Promise<void> {
  const coll = await checkpointsCollection();
  await coll.updateOne(
    { folderId },
    { $addToSet: { inflightIds: id }, $set: { updatedAt: Date.now() } },
    { upsert: true }
  );
}

export async function clearInflight(folderId: string, id: string): Promise<void> {
  const coll = await checkpointsCollection();
  await coll.updateOne(
    { folderId },
    { $pull: { inflightIds: id }, $set: { updatedAt: Date.now() } }
  );
}
