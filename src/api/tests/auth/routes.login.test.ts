import { describe, it, expect, beforeEach } from "bun:test";
import { Elysia } from "elysia";
import { authRoutes } from "../../src/routes/auth.ts";
import {
  usersCollection,
  refreshTokensCollection,
  challengesCollection,
} from "../../src/db/client.ts";

process.env.MAPLE_JWT_SECRET = "x".repeat(32);
const app = new Elysia().use(authRoutes);

beforeEach(async () => {
  for (const c of [usersCollection, refreshTokensCollection, challengesCollection]) {
    await (await c()).deleteMany({});
  }
});

describe("login flow", () => {
  it("404 on login/options for unknown email", async () => {
    const r = await app.handle(
      new Request("http://localhost/api/auth/login/options", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "ghost@nope.io" }),
      })
    );
    expect(r.status).toBe(404);
  });
});

describe("refresh", () => {
  it("401 without token", async () => {
    const r = await app.handle(
      new Request("http://localhost/api/auth/refresh", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      })
    );
    expect(r.status).toBe(401);
  });

  it("401 on unknown token", async () => {
    const r = await app.handle(
      new Request("http://localhost/api/auth/refresh", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ refresh_token: "garbage" }),
      })
    );
    expect(r.status).toBe(401);
  });
});
