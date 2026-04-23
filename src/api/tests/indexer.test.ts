/**
 * T7 indexer tests — channel mechanics + service status shape.
 *
 * Tests that need a live MongoDB are gated behind `describe.skipIf`.
 */

import { describe, it, expect } from "bun:test";

describe("BoundedQueue", () => {
  it("respects capacity and awaits push when full", async () => {
    const { createBoundedQueue } = await import("../src/indexer/channel.ts");
    const q = createBoundedQueue<number>(2);
    await q.push(1);
    await q.push(2);
    expect(q.depth).toBe(2);

    // Third push must block until a take drains a slot.
    let resolved = false;
    const p = q.push(3).then(() => { resolved = true; });

    // Immediately check it hasn't resolved yet.
    await Promise.resolve();
    expect(resolved).toBe(false);

    const iter = q.take();
    const first = await iter.next();
    expect(first.value).toBe(1);

    await p;
    expect(resolved).toBe(true);
    q.close();
  });

  it("emits items to multiple concurrent takers exactly once each", async () => {
    const { createBoundedQueue } = await import("../src/indexer/channel.ts");
    const q = createBoundedQueue<string>(4);
    const got: string[] = [];

    async function consume(): Promise<void> {
      for await (const v of q.take()) got.push(v);
    }
    const c1 = consume();
    const c2 = consume();

    await q.push("a");
    await q.push("b");
    await q.push("c");
    q.close();

    await Promise.all([c1, c2]);
    expect(got.sort()).toEqual(["a", "b", "c"]);
  });
});

describe("poolSizes", () => {
  it("clamps >= 1 for every stage", async () => {
    const { poolSizes } = await import("../src/indexer/channel.ts");
    const p = poolSizes();
    for (const v of Object.values(p)) expect(v).toBeGreaterThanOrEqual(1);
    expect(p.discover).toBe(4);
    expect(p.mongo).toBe(8);
  });
});

describe("IndexerService.status", () => {
  it("returns the expected shape without DB", async () => {
    const { IndexerService } = await import("../src/indexer/service.ts");
    const svc = new IndexerService();
    const s = svc.status();
    expect(typeof s.started).toBe("boolean");
    expect(typeof s.folders).toBe("number");
    for (const stage of ["discover", "hash", "exif", "thumb", "ai", "mongo"] as const) {
      expect(s.channels[stage].capacity).toBeGreaterThan(0);
      expect(s.stages[stage].inFlight).toBe(0);
      expect(s.pools[stage]).toBeGreaterThanOrEqual(1);
    }
  });
});
