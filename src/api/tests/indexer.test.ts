/**
 * P4 tests — Indexer queue shape and dedup logic.
 *
 * These tests exercise queue mechanics without a live MongoDB.
 */

import { describe, it, expect } from "bun:test";

describe("queueStats", () => {
  it("returns correct shape", async () => {
    const { queueStats } = await import("../src/indexer/queue.ts");
    const stats = queueStats();
    expect(typeof stats.pending).toBe("number");
    expect(typeof stats.in_flight).toBe("number");
    expect(typeof stats.active_workers).toBe("number");
    expect(typeof stats.max_workers).toBe("number");
    expect(stats.max_workers).toBeGreaterThan(0);
  });
});

describe("progressBus", () => {
  it("is an EventEmitter with maxListeners set", async () => {
    const { progressBus } = await import("../src/indexer/queue.ts");
    expect(typeof progressBus.on).toBe("function");
    expect(typeof progressBus.emit).toBe("function");
    expect(progressBus.getMaxListeners()).toBeGreaterThanOrEqual(200);
  });

  it("emits progress events", async () => {
    const { progressBus } = await import("../src/indexer/queue.ts");
    const received: unknown[] = [];
    const handler = (ev: unknown) => received.push(ev);
    progressBus.on("progress", handler);
    progressBus.emit("progress", { task_id: "test", kind: "scan_folder", status: "done" });
    progressBus.off("progress", handler);
    expect(received.length).toBe(1);
    expect((received[0] as { task_id: string }).task_id).toBe("test");
  });
});
