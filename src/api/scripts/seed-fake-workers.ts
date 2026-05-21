/**
 * Local-dev seed: inject fake workers data into MongoDB.
 *
 * Bootstraps `worker_config` for every stage in the manifest and a synthetic
 * set of `assets` rows distributed across the stages with realistic pending /
 * dead counts. Lets the redesigned `/settings/workers` UI render a populated
 * table without needing to crawl a real library.
 *
 * Usage:
 *   bun run src/api/scripts/seed-fake-workers.ts
 *   bun run src/api/scripts/seed-fake-workers.ts --reset   # drop assets first
 *
 * Safe to run repeatedly; uses upserts keyed on stage name / asset id.
 */

import { MongoClient } from "mongodb";
import { ALL_STAGE_NAMES, blankStagesSkeleton } from "../src/workers/stages/manifest.ts";

const MONGO_URL = process.env.MONGO_URL ?? "mongodb://localhost:27017";
const DB_NAME = process.env.MAPLE_MONGO_DB ?? "maple";
const RESET = process.argv.includes("--reset");

// Per-stage tuning so the UI looks like a real pipeline with some stages
// ahead of others. Numbers reflect a partially-processed 5000-asset library.
const SHAPE: Record<
  string,
  {
    config: { concurrency: number; pollIntervalMs: number; batchSize: number; maxAttempts: number };
    pending: number;
    dead: number;
  }
> = {
  hash:     { config: { concurrency: 4,  pollIntervalMs: 1000, batchSize: 10, maxAttempts: 5 }, pending: 0,    dead: 0 },
  exif:     { config: { concurrency: 4,  pollIntervalMs: 1000, batchSize: 10, maxAttempts: 5 }, pending: 12,   dead: 0 },
  thumb:    { config: { concurrency: 2,  pollIntervalMs: 1000, batchSize: 5,  maxAttempts: 5 }, pending: 87,   dead: 1 },
  preview:  { config: { concurrency: 2,  pollIntervalMs: 1500, batchSize: 5,  maxAttempts: 5 }, pending: 244,  dead: 0 },
  describe: { config: { concurrency: 3,  pollIntervalMs: 2000, batchSize: 5,  maxAttempts: 5 }, pending: 1873, dead: 9 },
  geocode:  { config: { concurrency: 1,  pollIntervalMs: 1000, batchSize: 20, maxAttempts: 5 }, pending: 412,  dead: 23 },
  face:     { config: { concurrency: 10, pollIntervalMs: 1000, batchSize: 5,  maxAttempts: 5 }, pending: 198,  dead: 0 },
  meili:    { config: { concurrency: 32, pollIntervalMs: 500,  batchSize: 20, maxAttempts: 5 }, pending: 3120, dead: 0 },
};

async function main(): Promise<void> {
  const client = new MongoClient(MONGO_URL);
  await client.connect();
  const db = client.db(DB_NAME);

  if (RESET) {
    console.log(`[reset] dropping assets + worker_config in ${DB_NAME}`);
    await db.collection("assets").deleteMany({});
    await db.collection("worker_config").deleteMany({});
  }

  // ── worker_config: one doc per stage ────────────────────────────────────
  const configColl = db.collection("worker_config");
  for (const name of ALL_STAGE_NAMES) {
    const shape = SHAPE[name];
    if (!shape) continue;
    await configColl.updateOne(
      { name },
      {
        $set: {
          name,
          ...shape.config,
          paused: false,
          last_seen_target_version: 1,
        },
      },
      { upsert: true },
    );
  }
  console.log(`[seed] upserted ${ALL_STAGE_NAMES.length} worker_config rows`);

  // ── assets: one doc per (stage, pending|dead) bucket  ──────────────────
  // The status route counts via `stages.${name}.version < targetVersion` and
  // `stages.${name}.dead == true`. We craft asset docs whose `stages` map
  // satisfies those queries for exactly one stage per doc — keeps the seed
  // light (one doc = one unit of "pending" or "dead") at the cost of needing
  // SHAPE.pending docs per stage. Cheap; this is a dev fixture, not prod.
  const assetsColl = db.collection("assets");
  let docCount = 0;
  for (const name of ALL_STAGE_NAMES) {
    const shape = SHAPE[name];
    if (!shape) continue;

    // PENDING — version below target (target=1, so version=0 satisfies).
    for (let i = 0; i < shape.pending; i++) {
      const id = `seed-pending-${name}-${i}`;
      const stages = blankStagesSkeleton();
      // Mark every other stage as "done" so this doc only counts for `name`.
      for (const other of ALL_STAGE_NAMES) {
        if (other !== name) stages[other].version = 1;
      }
      await assetsColl.updateOne(
        { _id: id as unknown as never },
        { $set: { _id: id, abs_path: `/seed/${id}.jpg`, stages } },
        { upsert: true },
      );
      docCount++;
    }

    // DEAD — `stages.${name}.dead == true`. Independent of pending.
    for (let i = 0; i < shape.dead; i++) {
      const id = `seed-dead-${name}-${i}`;
      const stages = blankStagesSkeleton();
      stages[name].dead = true;
      stages[name].attempts = 5;
      stages[name].last_error = "seed: simulated failure for UI testing";
      for (const other of ALL_STAGE_NAMES) {
        if (other !== name) stages[other].version = 1;
      }
      await assetsColl.updateOne(
        { _id: id as unknown as never },
        { $set: { _id: id, abs_path: `/seed/${id}.jpg`, stages } },
        { upsert: true },
      );
      docCount++;
    }
  }
  console.log(`[seed] upserted ${docCount} asset rows across ${ALL_STAGE_NAMES.length} stages`);

  await client.close();
  console.log("[seed] done");
}

main().catch((err) => {
  console.error("[seed] FAILED:", err);
  process.exit(1);
});
