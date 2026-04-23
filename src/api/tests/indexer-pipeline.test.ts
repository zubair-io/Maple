/**
 * Pipeline integration test — feed one fake file through all stages and
 * assert mongo upsert is called exactly once. Disk + AI are mocked.
 */

import { describe, it, expect } from "bun:test";

describe("Pipeline end-to-end", () => {
  it("routes one job through every stage and calls mongo upsert once", async () => {
    const { Pipeline, createChannels } = await import("../src/indexer/pipeline.ts");

    const upsertCalls: Array<{ mapleId?: string; absPath: string }> = [];
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
        upsertCalls.push({ mapleId: job.mapleId, absPath: job.absPath });
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

    await pipe.stop();
    await fs.rm(dir, { recursive: true, force: true });
  });
});
