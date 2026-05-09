import { describe, expect, it } from "bun:test";

describe("worker routes mount smoke test", () => {
  it("GET /api/workers/status returns 200", async () => {
    // This test imports the live app and hits the route.
    // It requires no MongoDB connection because the supervisor has no stages.
    const { buildApp } = await import("../index.ts");
    const app = buildApp({ stageNames: [] });

    const res = await app.handle(
      new Request("http://localhost/api/workers/status"),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.stages)).toBe(true);
  });
});
