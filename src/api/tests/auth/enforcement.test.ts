import { describe, it, expect } from "bun:test";
import { Elysia } from "elysia";
import { healthRoutes } from "../../src/routes/health.ts";
import { authRoutes } from "../../src/routes/auth.ts";
import { requireAuth } from "../../src/auth/middleware.ts";
import { foldersRoutes } from "../../src/routes/folders.ts";

process.env.MAPLE_JWT_SECRET = "x".repeat(32);

const app = new Elysia()
  .use(healthRoutes)
  .use(authRoutes)
  .use(requireAuth)
  .use(foldersRoutes);

describe("global enforcement", () => {
  it("/api/health is open", async () => {
    const r = await app.handle(new Request("http://localhost/api/health"));
    expect(r.status).toBe(200);
  });
  it("/api/auth/bootstrap is open", async () => {
    const r = await app.handle(new Request("http://localhost/api/auth/bootstrap"));
    expect(r.status).toBe(200);
  });
  it("/api/folders requires bearer", async () => {
    const r = await app.handle(new Request("http://localhost/api/folders"));
    expect(r.status).toBe(401);
  });
});
