import { describe, expect, it } from "bun:test";
import { defineStage } from "./define-stage.ts";
import type { StageConfig, StageResult, StageState, WorkerConfig } from "./define-stage.ts";

describe("defineStage", () => {
  it("returns the config object unchanged", () => {
    const cfg = defineStage({
      name: "test",
      targetVersion: 1,
      dependsOn: [],
      defaults: {
        concurrency: 2,
        pollIntervalMs: 1000,
        batchSize: 5,
        maxAttempts: 3,
        paused: false,
        pausedOnFirstBoot: false,
      },
      handler: async (_image, _ctx) => ({ patch: { test: true } }),
    });
    expect(cfg.name).toBe("test");
    expect(cfg.targetVersion).toBe(1);
    expect(cfg.dependsOn).toEqual([]);
    expect(cfg.defaults.concurrency).toBe(2);
  });

  it("accepts { wrote: true } result shape", () => {
    const cfg = defineStage({
      name: "meili",
      targetVersion: 1,
      dependsOn: ["exif"],
      defaults: {
        concurrency: 2,
        pollIntervalMs: 1000,
        batchSize: 20,
        maxAttempts: 5,
        paused: false,
        pausedOnFirstBoot: false,
      },
      handler: async (_image, _ctx): Promise<StageResult> => ({ wrote: true }),
    });
    expect(cfg.name).toBe("meili");
  });

  it("accepts { skip: string } result shape", () => {
    const cfg = defineStage({
      name: "face",
      targetVersion: 1,
      dependsOn: ["thumb"],
      defaults: {
        concurrency: 1,
        pollIntervalMs: 1000,
        batchSize: 5,
        maxAttempts: 5,
        paused: false,
        pausedOnFirstBoot: false,
      },
      handler: async (_image, _ctx): Promise<StageResult> => ({
        skip: "not an image",
      }),
    });
    expect(cfg.name).toBe("face");
  });

  it("StageState has required shape", () => {
    const s: StageState = {
      version: 0,
      attempts: 0,
      last_error: null,
      processed_at: null,
      dead: false,
    };
    expect(s.version).toBe(0);
    expect(s.dead).toBe(false);
  });

  it("WorkerConfig has required shape", () => {
    const wc: WorkerConfig = {
      concurrency: 4,
      pollIntervalMs: 1000,
      batchSize: 10,
      maxAttempts: 5,
      paused: false,
      last_seen_target_version: 0,
    };
    expect(wc.last_seen_target_version).toBe(0);
  });
});
