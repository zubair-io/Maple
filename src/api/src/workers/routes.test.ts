import { describe, expect, it } from "bun:test";
import { Elysia } from "elysia";
import { workerRoutes } from "./routes.ts";
import { Supervisor } from "./supervisor.ts";

describe("GET /api/workers/status", () => {
  it("returns an empty stages array when supervisor has no stages", async () => {
    const sup = new Supervisor([]);
    const app = new Elysia().use(workerRoutes(sup));

    const res = await app.handle(
      new Request("http://localhost/api/workers/status"),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty("stages");
    expect(Array.isArray(body.stages)).toBe(true);
    expect(body.stages).toHaveLength(0);
  });
});

describe("POST /api/workers/:name/pause", () => {
  it("returns 404 for unknown stage", async () => {
    const sup = new Supervisor([]);
    const app = new Elysia().use(workerRoutes(sup));
    const res = await app.handle(
      new Request("http://localhost/api/workers/nonexistent/pause", { method: "POST" }),
    );
    expect(res.status).toBe(404);
  });
});

describe("POST /api/workers/:name/resume", () => {
  it("returns 404 for unknown stage", async () => {
    const sup = new Supervisor([]);
    const app = new Elysia().use(workerRoutes(sup));
    const res = await app.handle(
      new Request("http://localhost/api/workers/nonexistent/resume", { method: "POST" }),
    );
    expect(res.status).toBe(404);
  });
});

describe("POST /api/workers/:name/retry-dead", () => {
  it("returns 404 for unknown stage", async () => {
    const sup = new Supervisor([]);
    const app = new Elysia().use(workerRoutes(sup));
    const res = await app.handle(
      new Request("http://localhost/api/workers/nonexistent/retry-dead", { method: "POST" }),
    );
    expect(res.status).toBe(404);
  });
});

describe("PATCH /api/workers/:name/config", () => {
  it("returns 404 for unknown stage", async () => {
    const sup = new Supervisor([]);
    const app = new Elysia().use(workerRoutes(sup));
    const res = await app.handle(
      new Request("http://localhost/api/workers/nonexistent/config", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ concurrency: 4 }),
      }),
    );
    expect(res.status).toBe(404);
  });
});
