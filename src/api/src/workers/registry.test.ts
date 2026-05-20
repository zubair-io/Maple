/**
 * Unit tests for `StageRegistry` — focused on the pre-registration contract:
 * `GET /api/workers/status` must report every stage the orchestrator plans
 * to start, even when the stage's `bootConfig()` is still mid-retry or has
 * permanently failed. Regression-guards the fix from PR #164 review.
 */
import { describe, it, expect, beforeEach } from "bun:test";
import {
  stageRegistry,
  type StageRegistryEntry,
} from "./registry.ts";

function fakeEntry(overrides: Partial<StageRegistryEntry> = {}): StageRegistryEntry {
  return {
    targetVersion: 1,
    getInFlight: () => 0,
    getThroughput: () => 0,
    getPaused: () => false,
    reloadConfig: async () => {},
    pause: async () => {},
    resume: async () => {},
    ...overrides,
  };
}

describe("StageRegistry.statuses() pre-registration", () => {
  beforeEach(() => stageRegistry._resetForTests());

  it("returns a 'stopped' row for a pre-registered stage that hasn't booted", () => {
    stageRegistry.preregister("hash", 3);
    const s = stageRegistry.statuses();
    expect(s.hash).toBeDefined();
    expect(s.hash).toEqual({
      status: "stopped",
      inFlight: 0,
      throughput: 0,
      targetVersion: 3,
      lastError: null,
    });
  });

  it("returns an 'error' row when recordError fires on a pre-registered stage", () => {
    stageRegistry.preregister("face", 2);
    stageRegistry.recordError("face", "ONNX model missing");
    const s = stageRegistry.statuses();
    expect(s.face).toEqual({
      status: "error",
      inFlight: 0,
      throughput: 0,
      targetVersion: 2,
      lastError: "ONNX model missing",
    });
  });

  it("live register() supersedes the pre-registration stub", () => {
    stageRegistry.preregister("exif", 4);
    stageRegistry.register("exif", fakeEntry({ targetVersion: 4 }));
    const s = stageRegistry.statuses();
    expect(s.exif).toEqual({
      status: "running",
      inFlight: 0,
      throughput: 0,
      targetVersion: 4,
      lastError: null,
    });
  });

  it("statuses() returns every pre-registered stage even when none have booted", () => {
    const names = [
      "hash",
      "exif",
      "thumb",
      "preview",
      "face",
      "describe",
      "geocode",
      "meili",
    ];
    for (const n of names) stageRegistry.preregister(n, 1);
    const s = stageRegistry.statuses();
    expect(Object.keys(s).sort()).toEqual(names.sort());
    for (const n of names) {
      expect(s[n]!.status).toBe("stopped");
    }
  });

  it("after unregister(), the pre-registered stub re-appears with 'stopped'", () => {
    stageRegistry.preregister("thumb", 2);
    stageRegistry.register("thumb", fakeEntry({ targetVersion: 2 }));
    expect(stageRegistry.statuses().thumb!.status).toBe("running");
    stageRegistry.unregister("thumb");
    // Stage stopped — should still surface as 'stopped' so the UI shows
    // the row instead of dropping it (matches old supervisor contract).
    expect(stageRegistry.statuses().thumb!.status).toBe("stopped");
  });

  it("preregister is idempotent — re-calling updates targetVersion in place", () => {
    stageRegistry.preregister("meili", 1);
    stageRegistry.preregister("meili", 5);
    expect(stageRegistry.statuses().meili!.targetVersion).toBe(5);
  });
});
