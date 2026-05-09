/**
 * Registry — Mongo-backed cache integration tests.
 *
 * The registry is a thin cache over the `stage_handlers` collection, so the
 * tests round-trip against real Mongo.
 */

import { describe, it, expect, beforeEach, afterAll } from "bun:test";
import { stageHandlersCollection } from "../db/client.ts";
import { resolve, __resetForTests } from "./registry.ts";

async function clearStageHandlers(): Promise<void> {
  const coll = await stageHandlersCollection();
  await coll.deleteMany({});
}

describe("registry.resolve", () => {
  beforeEach(async () => {
    __resetForTests();
    await clearStageHandlers();
  });

  afterAll(async () => {
    await clearStageHandlers();
    __resetForTests();
  });

  it("returns the builtin descriptor when no row exists", async () => {
    const r = await resolve("ai");
    expect(r.impl).toBe("builtin");
    expect(r.url).toBeNull();
  });

  it("returns the http descriptor when an enabled row exists", async () => {
    const coll = await stageHandlersCollection();
    await coll.insertOne({
      stage: "ai",
      impl: "http",
      url: "https://example.invalid/ai",
      timeout_ms: 5000,
      enabled: true,
    });

    const r = await resolve("ai");
    expect(r.impl).toBe("http");
    expect(r.url).toBe("https://example.invalid/ai");
    expect(r.timeoutMs).toBe(5000);
  });

  it("treats disabled rows as if they did not exist", async () => {
    const coll = await stageHandlersCollection();
    await coll.insertOne({
      stage: "ai",
      impl: "http",
      url: "https://example.invalid/ai",
      enabled: false,
    });

    const r = await resolve("ai");
    expect(r.impl).toBe("builtin");
  });

  it("caches: changing the row after the first resolve does not affect the second", async () => {
    // Behavioural cache check that doesn't rely on internal monkey-patching:
    // 1. Insert row A and resolve — populates the cache.
    // 2. Mutate the row in Mongo to value B.
    // 3. Resolve again WITHOUT calling refresh() — must still see A.
    // 4. refresh(), resolve again — must see B.
    const coll = await stageHandlersCollection();
    await coll.insertOne({
      stage: "ai",
      impl: "http",
      url: "https://example.invalid/cache-A",
      enabled: true,
    });

    const first = await resolve("ai");
    expect(first.url).toBe("https://example.invalid/cache-A");

    await coll.updateOne(
      { stage: "ai" },
      { $set: { url: "https://example.invalid/cache-B" } }
    );

    const second = await resolve("ai");
    expect(second.url).toBe("https://example.invalid/cache-A");

    __resetForTests();
    const third = await resolve("ai");
    expect(third.url).toBe("https://example.invalid/cache-B");
  });
});
