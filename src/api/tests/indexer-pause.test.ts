import { describe, it, expect } from "bun:test";
import * as os from "node:os";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Pipeline, type PipelineHandlers } from "../src/indexer/pipeline.ts";

function sleep(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms));
}

describe("Pipeline pause/resume", () => {
  it("pause() stops new jobs from being pulled, resume() restarts", async () => {
    let processed = 0;

    // Create a temp dir with real (empty) files so the hash stage's fs.stat
    // succeeds. readHead is overridden to return zeros so no actual I/O.
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "maple-pause-test-"));
    const filePaths: string[] = [];
    for (let i = 0; i < 6; i++) {
      const p = path.join(tmpDir, `file${i}.dng`);
      await fs.writeFile(p, Buffer.alloc(64));
      filePaths.push(p);
    }

    // Minimal handler set: fake readHead, no-op exif/thumb/ai,
    // count in upsertMongo (final stage).
    const handlers: PipelineHandlers = {
      readHead: async (_absPath: string) => {
        return new Uint8Array(64);
      },
      readExif: async (_job) => {
        // no-op: leave capturedAt undefined so deriveId uses fallback form
      },
      generateThumb: async (_job) => {
        // no-op
      },
      runAi: async (_job) => {
        // no-op
      },
      upsertMongo: async (_job) => {
        processed++;
      },
    };

    const pipeline = new Pipeline(
      undefined,
      { discover: 1, hash: 1, exif: 1, thumb: 1, ai: 1, mongo: 1 },
      handlers,
    );
    pipeline.start();

    // Enqueue 3 discover jobs.
    for (let i = 0; i < 3; i++) {
      await pipeline.channels.discover.push({
        kind: "index",
        folderId: "000000000000000000000000",
        absPath: filePaths[i]!,
      });
    }
    // Let the first job process.
    await sleep(150);
    expect(processed).toBeGreaterThanOrEqual(1);

    pipeline.pause();
    expect(pipeline.status().paused).toBe(true);

    const before = processed;
    // Enqueue more — they should sit in the channel.
    for (let i = 3; i < 6; i++) {
      await pipeline.channels.discover.push({
        kind: "index",
        folderId: "000000000000000000000000",
        absPath: filePaths[i]!,
      });
    }
    await sleep(80);
    expect(processed).toBe(before); // nothing new processed while paused

    pipeline.resume();
    expect(pipeline.status().paused).toBe(false);
    await sleep(150);
    expect(processed).toBeGreaterThan(before);

    await pipeline.stop();
    await fs.rm(tmpDir, { recursive: true });
  });

  it("pause() and resume() are idempotent", () => {
    const pipeline = new Pipeline();
    pipeline.pause();
    pipeline.pause(); // no-op
    expect(pipeline.status().paused).toBe(true);
    pipeline.resume();
    pipeline.resume(); // no-op
    expect(pipeline.status().paused).toBe(false);
  });
});

describe("POST /api/indexer/pause + /resume", () => {
  it("pauses and resumes the singleton indexer service", async () => {
    const { indexerRoutes } = await import("../src/routes/indexer.ts");

    const pauseRes = await indexerRoutes.handle(
      new Request("http://localhost/api/indexer/pause", { method: "POST" }),
    );
    expect(pauseRes.status).toBe(200);
    const pauseJson = await pauseRes.json();
    expect(pauseJson.status.paused).toBe(true);

    const resumeRes = await indexerRoutes.handle(
      new Request("http://localhost/api/indexer/resume", { method: "POST" }),
    );
    expect(resumeRes.status).toBe(200);
    const resumeJson = await resumeRes.json();
    expect(resumeJson.status.paused).toBe(false);
  });
});
