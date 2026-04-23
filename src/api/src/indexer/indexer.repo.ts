/**
 * Indexer-side Mongo accessors: dead-letter queue, etc.
 *
 * Callers go through this module so routes never talk to collections
 * directly (repository pattern).
 */

import type { Collection } from "mongodb";
import { getDb } from "../db/client.ts";
import type { Stage } from "./channel.ts";

export interface DeadLetterDoc {
  /** maple:id hex if available; otherwise abs_path. */
  key: string;
  stage: Stage;
  absPath: string;
  error: string;
  attempts: number;
  firstFailedAt: string;
  lastFailedAt: string;
}

export async function deadLetterCollection(): Promise<Collection<DeadLetterDoc>> {
  const db = await getDb();
  return db.collection<DeadLetterDoc>("indexer_dead_letter");
}

export async function ensureIndexerIndexes(): Promise<void> {
  const coll = await deadLetterCollection();
  await coll.createIndex({ key: 1, stage: 1 }, { unique: true });
  await coll.createIndex({ lastFailedAt: -1 });
}

export async function recordDeadLetter(input: {
  key: string;
  stage: Stage;
  absPath: string;
  error: string;
  attempts: number;
}): Promise<void> {
  const coll = await deadLetterCollection();
  const now = new Date().toISOString();
  await coll.updateOne(
    { key: input.key, stage: input.stage },
    {
      $set: {
        absPath: input.absPath,
        error: input.error,
        attempts: input.attempts,
        lastFailedAt: now,
      },
      $setOnInsert: { firstFailedAt: now, stage: input.stage, key: input.key },
    },
    { upsert: true }
  );
}

export async function listDeadLetter(limit = 200): Promise<DeadLetterDoc[]> {
  const coll = await deadLetterCollection();
  return coll.find({}).sort({ lastFailedAt: -1 }).limit(limit).toArray();
}
