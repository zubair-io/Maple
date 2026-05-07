/**
 * Pipeline integration test — feed one fake file through all stages and
 * assert mongo upsert is called exactly once. Disk + AI are mocked.
 */

import { describe, it, expect } from "bun:test";

describe("Pipeline end-to-end", () => {
  it("routes one job through every stage and calls mongo upsert once", async () => {
    const { Pipeline, createChannels } = await import("../src/indexer/pipeline.ts");

    const upsertCalls: Array<{ mapleId?: string; absPath: string; faces?: number; aiTags?: number }> = [];
    const exifCalls: string[] = [];
    const thumbCalls: string[] = [];
    const aiCalls: string[] = [];

    const fakeBytes = new Uint8Array(128);
    for (let i = 0; i < fakeBytes.length; i++) fakeBytes[i] = i;

    const channels = createChannels();
    const pools = {
      discover: 1, hash: 1, exif: 1, thumb: 1, ai: 1, mongo: 1,
    } as const;
    const pipe = new Pipeline(channels, { ...pools }, {
      readHead: async () => fakeBytes,
      readExif: async (job) => { exifCalls.push(job.absPath); },
      generateThumb: async (job) => { thumbCalls.push(job.absPath); },
      runAi: async (job) => { aiCalls.push(job.absPath); },
      upsertMongo: async (job) => {
        upsertCalls.push({
          mapleId: job.mapleId,
          absPath: job.absPath,
          faces: job.faces?.length,
          aiTags: job.aiTags?.length,
        });
      },
    });

    // Override the filesystem stat lookup by monkey-patching node:fs/promises.
    // Easier: feed a path we know doesn't exist and let the hash stage's
    // stat() call fail — but we need real mtime/size for upsert.
    // Approach: create a tiny temp file.
    const os = await import("node:os");
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "maple-pipeline-"));
    const p = path.join(dir, "fake.dng");
    await fs.writeFile(p, Buffer.from(fakeBytes));

    pipe.start();
    // 24-char fake folder ObjectId
    await pipe.channels.discover.push({
      kind: "index",
      folderId: "ffffffffffffffffffffffff",
      absPath: p,
    });

    // Wait until upsert has been called once or timeout.
    const deadline = Date.now() + 5000;
    while (upsertCalls.length < 1 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 20));
    }

    expect(upsertCalls.length).toBe(1);
    expect(exifCalls.length).toBe(1);
    expect(thumbCalls.length).toBe(1);
    expect(aiCalls.length).toBe(1);
    expect(upsertCalls[0]!.mapleId).toBeTruthy();
    // ai stage always seeds faces/aiTags arrays so the mongo schema stays stable.
    expect(upsertCalls[0]!.faces).toBe(0);
    expect(upsertCalls[0]!.aiTags).toBe(0);
    // No capturedAt supplied -> fallback form (tag 0x02).
    expect(upsertCalls[0]!.mapleId!.startsWith("02")).toBe(true);

    await pipe.stop();
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("exif stage upgrades maple:id to primary form once capturedAt is parsed", async () => {
    const { Pipeline, createChannels } = await import("../src/indexer/pipeline.ts");
    const { primary } = await import("../src/indexer/id.ts");

    const fakeBytes = new Uint8Array(256);
    for (let i = 0; i < fakeBytes.length; i++) fakeBytes[i] = (i * 3) & 0xff;
    const capturedAt = "2024:06:01 12:34:56";
    const serial = "SN-9999";
    const shutter = 1234n;
    const expected = primary(fakeBytes, capturedAt, serial, shutter);

    const channels = createChannels();
    const upsertCalls: Array<{ mapleId?: string }> = [];
    const pipe = new Pipeline(channels, {
      discover: 1, hash: 1, exif: 1, thumb: 1, ai: 1, mongo: 1,
    }, {
      readHead: async () => fakeBytes,
      readExif: async (job) => {
        job.capturedAt = capturedAt;
        job.cameraSerial = serial;
        job.shutterCount = shutter;
      },
      upsertMongo: async (job) => { upsertCalls.push({ mapleId: job.mapleId }); },
    });

    const os = await import("node:os");
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "maple-pipeline-primary-"));
    const p = path.join(dir, "primary.dng");
    await fs.writeFile(p, Buffer.from(fakeBytes));

    pipe.start();
    await pipe.channels.discover.push({
      kind: "index",
      folderId: "ffffffffffffffffffffffff",
      absPath: p,
    });

    const deadline = Date.now() + 5000;
    while (upsertCalls.length < 1 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 20));
    }

    expect(upsertCalls.length).toBe(1);
    // Primary form: tag byte 0x01, matches deriveId(primary) exactly.
    expect(upsertCalls[0]!.mapleId).toBe(expected.hex);
    expect(upsertCalls[0]!.mapleId!.startsWith("01")).toBe(true);

    await pipe.stop();
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("falls through to fallback form when capturedAt is absent", async () => {
    const { Pipeline, createChannels } = await import("../src/indexer/pipeline.ts");
    const { fallback } = await import("../src/indexer/id.ts");

    const fakeBytes = new Uint8Array(128);
    for (let i = 0; i < fakeBytes.length; i++) fakeBytes[i] = i;
    const expected = fallback(fakeBytes, fakeBytes.length);

    const channels = createChannels();
    const upsertCalls: Array<{ mapleId?: string }> = [];
    const pipe = new Pipeline(channels, {
      discover: 1, hash: 1, exif: 1, thumb: 1, ai: 1, mongo: 1,
    }, {
      readHead: async () => fakeBytes,
      // No readExif handler -> capturedAt stays undefined -> fallback.
      upsertMongo: async (job) => { upsertCalls.push({ mapleId: job.mapleId }); },
    });

    const os = await import("node:os");
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "maple-pipeline-fallback-"));
    const p = path.join(dir, "fallback.dng");
    await fs.writeFile(p, Buffer.from(fakeBytes));

    pipe.start();
    await pipe.channels.discover.push({
      kind: "index",
      folderId: "ffffffffffffffffffffffff",
      absPath: p,
    });

    const deadline = Date.now() + 5000;
    while (upsertCalls.length < 1 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 20));
    }

    expect(upsertCalls.length).toBe(1);
    expect(upsertCalls[0]!.mapleId).toBe(expected.hex);
    expect(upsertCalls[0]!.mapleId!.startsWith("02")).toBe(true);

    await pipe.stop();
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("skipThumb=true short-circuits the thumb handler but still upserts", async () => {
    const { Pipeline, createChannels } = await import("../src/indexer/pipeline.ts");

    const fakeBytes = new Uint8Array(128);
    for (let i = 0; i < fakeBytes.length; i++) fakeBytes[i] = i;

    const channels = createChannels();
    const thumbCalls: string[] = [];
    const upsertCalls: string[] = [];
    const pipe = new Pipeline(channels, {
      discover: 1, hash: 1, exif: 1, thumb: 1, ai: 1, mongo: 1,
    }, {
      readHead: async () => fakeBytes,
      generateThumb: async (job) => { thumbCalls.push(job.absPath); },
      upsertMongo: async (job) => { upsertCalls.push(job.absPath); },
    });

    const os = await import("node:os");
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "maple-pipeline-skipthumb-"));
    const p = path.join(dir, "skip.dng");
    await fs.writeFile(p, Buffer.from(fakeBytes));

    pipe.start();
    await pipe.channels.discover.push({
      kind: "index",
      folderId: "ffffffffffffffffffffffff",
      absPath: p,
      skipThumb: true,
    });

    const deadline = Date.now() + 5000;
    while (upsertCalls.length < 1 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 20));
    }

    expect(upsertCalls.length).toBe(1);
    expect(upsertCalls[0]).toBe(p);
    // The thumb handler must NOT have run for this job.
    expect(thumbCalls).toEqual([]);

    await pipe.stop();
    await fs.rm(dir, { recursive: true, force: true });
  });
});
