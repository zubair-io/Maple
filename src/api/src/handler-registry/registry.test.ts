/**
 * Registry — Mongo-backed cache and pipeline-adapter integration tests.
 *
 * The registry is a thin cache over the `stage_handlers` collection, so the
 * tests round-trip against real Mongo. The pipeline integration uses an
 * injected `fetch` to verify the `runAi` adapter dispatches over HTTP when
 * the active row says `impl: "http"`.
 */

import { describe, it, expect, beforeEach, afterAll } from "bun:test";
import { ObjectId } from "mongodb";
import { stageHandlersCollection } from "../db/client.ts";
import { resolve, __resetForTests } from "./registry.ts";
import { CONTRACT_VERSION } from "./contract.ts";

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

describe("Pipeline runAi adapter via registry + http transport", () => {
  beforeEach(async () => {
    __resetForTests();
    await clearStageHandlers();
  });

  afterAll(async () => {
    await clearStageHandlers();
    __resetForTests();
  });

  it("dispatches the ai stage to a configured HTTP url and merges the response", async () => {
    const coll = await stageHandlersCollection();
    await coll.insertOne({
      stage: "ai",
      impl: "http",
      url: "https://example.invalid/ai",
      enabled: true,
    });

    // Stub global fetch so the dispatcher hits our handler.
    const calls: Array<{ url: string; body: unknown }> = [];
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const text = typeof init?.body === "string" ? init.body : "";
      calls.push({ url: String(url), body: JSON.parse(text) });
      return new Response(
        JSON.stringify({
          contractVersion: CONTRACT_VERSION,
          faces: [
            { bbox: { x: 0.1, y: 0.1, w: 0.2, h: 0.2 }, personId: null, confidence: 0.95 },
          ],
          aiTags: ["sunset"],
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }) as unknown as typeof fetch;

    try {
      const { Pipeline, createChannels } = await import("../indexer/pipeline.ts");
      const fakeBytes = new Uint8Array(64);
      for (let i = 0; i < fakeBytes.length; i++) fakeBytes[i] = i * 7;

      const channels = createChannels();
      const upserts: Array<{ faces: number; aiTags: string[] }> = [];
      const pipe = new Pipeline(
        channels,
        { discover: 1, hash: 1, exif: 1, thumb: 1, ai: 1, mongo: 1 },
        {
          readHead: async () => fakeBytes,
          // No runAi override — that forces the registry adapter path.
          upsertMongo: async (job) => {
            upserts.push({ faces: job.faces?.length ?? 0, aiTags: job.aiTags ?? [] });
          },
        }
      );

      const os = await import("node:os");
      const fs = await import("node:fs/promises");
      const path = await import("node:path");
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), "maple-registry-"));
      const p = path.join(dir, "x.dng");
      await fs.writeFile(p, Buffer.from(fakeBytes));

      pipe.start();
      await pipe.channels.discover.push({
        kind: "index",
        folderId: new ObjectId().toHexString(),
        absPath: p,
      });

      const deadline = Date.now() + 5000;
      while (upserts.length < 1 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 20));
      }

      expect(upserts.length).toBe(1);
      expect(upserts[0]!.faces).toBe(1);
      expect(upserts[0]!.aiTags).toEqual(["sunset"]);
      expect(calls.length).toBe(1);
      const reqBody = calls[0]!.body as { stage: string; mapleId: string };
      expect(reqBody.stage).toBe("ai");
      expect(reqBody.mapleId).toBeTruthy();

      await pipe.stop();
      await fs.rm(dir, { recursive: true, force: true });
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it("falls through to builtin pass-through when no row exists", async () => {
    // Stub fetch to fail loudly — if the adapter mistakenly dispatches we
    // want a clear test failure.
    const origFetch = globalThis.fetch;
    let fetchCalled = false;
    globalThis.fetch = (async () => {
      fetchCalled = true;
      throw new Error("fetch should not be called");
    }) as unknown as typeof fetch;

    try {
      const { Pipeline, createChannels } = await import("../indexer/pipeline.ts");
      const fakeBytes = new Uint8Array(64);
      for (let i = 0; i < fakeBytes.length; i++) fakeBytes[i] = i;

      const channels = createChannels();
      const upserts: Array<{ faces: number; aiTags: number }> = [];
      const pipe = new Pipeline(
        channels,
        { discover: 1, hash: 1, exif: 1, thumb: 1, ai: 1, mongo: 1 },
        {
          readHead: async () => fakeBytes,
          upsertMongo: async (job) => {
            upserts.push({ faces: job.faces?.length ?? 0, aiTags: job.aiTags?.length ?? 0 });
          },
        }
      );

      const os = await import("node:os");
      const fs = await import("node:fs/promises");
      const path = await import("node:path");
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), "maple-registry-builtin-"));
      const p = path.join(dir, "y.dng");
      await fs.writeFile(p, Buffer.from(fakeBytes));

      pipe.start();
      await pipe.channels.discover.push({
        kind: "index",
        folderId: new ObjectId().toHexString(),
        absPath: p,
      });

      const deadline = Date.now() + 5000;
      while (upserts.length < 1 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 20));
      }

      expect(upserts.length).toBe(1);
      expect(upserts[0]!.faces).toBe(0);
      expect(upserts[0]!.aiTags).toBe(0);
      expect(fetchCalled).toBe(false);

      await pipe.stop();
      await fs.rm(dir, { recursive: true, force: true });
    } finally {
      globalThis.fetch = origFetch;
    }
  });
});
