// src/api/tests/auth/middleware.test.ts
import { describe, it, expect } from "bun:test";
import { Elysia } from "elysia";
import { requireAuth, requireOwner } from "../../src/auth/middleware.ts";
import { signAccessToken } from "../../src/auth/tokens.ts";

const SECRET = "test-secret-32-bytes-xxxxxxxxxxxx";
process.env.MAPLE_JWT_SECRET = SECRET;

const app = new Elysia()
  .use(requireAuth)
  .get("/me", ({ auth }) => ({ sub: auth.user.sub }))
  .use(requireOwner)
  .post("/owner-only", () => ({ ok: true }));

describe("middleware", () => {
  it("rejects /me without bearer", async () => {
    const r = await app.handle(new Request("http://localhost/me"));
    expect(r.status).toBe(401);
  });
  it("accepts /me with valid bearer", async () => {
    const t = signAccessToken({ sub: "u1", email: "a@b.c", role: "member" }, SECRET);
    const r = await app.handle(new Request("http://localhost/me", { headers: { authorization: `Bearer ${t}` } }));
    expect(r.status).toBe(200);
  });
  it("rejects member from owner route", async () => {
    const t = signAccessToken({ sub: "u1", email: "a@b.c", role: "member" }, SECRET);
    const r = await app.handle(new Request("http://localhost/owner-only", {
      method: "POST", headers: { authorization: `Bearer ${t}` },
    }));
    expect(r.status).toBe(403);
  });
  it("allows owner on owner route", async () => {
    const t = signAccessToken({ sub: "u1", email: "a@b.c", role: "owner" }, SECRET);
    const r = await app.handle(new Request("http://localhost/owner-only", {
      method: "POST", headers: { authorization: `Bearer ${t}` },
    }));
    expect(r.status).toBe(200);
  });
});
