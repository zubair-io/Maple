import { describe, expect, it } from "bun:test";

describe("worker routes mount smoke test", () => {
  it("GET /api/workers/status is mounted and requires auth", async () => {
    const { buildApp } = await import("../index.ts");
    const app = buildApp({ stageNames: [] });

    const res = await app.handle(
      new Request("http://localhost/api/workers/status"),
    );
    // 401 is expected — the routes are mounted but require auth.
    expect(res.status).toBe(401);
  });
});
