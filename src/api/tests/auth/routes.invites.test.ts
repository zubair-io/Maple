// src/api/tests/auth/routes.invites.test.ts
import { describe, it, expect, beforeEach } from "bun:test";
import { Elysia } from "elysia";
import { ObjectId } from "mongodb";
import { authRoutes } from "../../src/routes/auth.ts";
import { signAccessToken } from "../../src/auth/tokens.ts";
import { invitesCollection, usersCollection } from "../../src/db/client.ts";

process.env.MAPLE_JWT_SECRET = "x".repeat(32);
const app = new Elysia().use(authRoutes);

const ownerId = new ObjectId();
const memberId = new ObjectId();
const ownerJwt = signAccessToken(
  { sub: ownerId.toHexString(), email: "o@m.c", role: "owner" },
  "x".repeat(32)
);
const memberJwt = signAccessToken(
  { sub: memberId.toHexString(), email: "m@m.c", role: "member" },
  "x".repeat(32)
);

beforeEach(async () => {
  await (await invitesCollection()).deleteMany({});
  await (await usersCollection()).deleteMany({});
});

describe("invites CRUD", () => {
  it("rejects member from POST /invites", async () => {
    const r = await app.handle(
      new Request("http://localhost/api/auth/invites", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${memberJwt}`,
        },
        body: JSON.stringify({ email: "x@y.z" }),
      })
    );
    expect(r.status).toBe(403);
  });

  it("owner creates and lists an invite", async () => {
    const r = await app.handle(
      new Request("http://localhost/api/auth/invites", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${ownerJwt}`,
        },
        body: JSON.stringify({ email: "alice@x.y" }),
      })
    );
    expect(r.status).toBe(200);
    const { code } = await r.json();

    const list = await app.handle(
      new Request("http://localhost/api/auth/invites", {
        headers: { authorization: `Bearer ${ownerJwt}` },
      })
    );
    const items = await list.json();
    expect(items.find((i: any) => i.code === code)).toBeDefined();
  });

  it("owner rescinds an invite", async () => {
    const cr = await app.handle(
      new Request("http://localhost/api/auth/invites", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${ownerJwt}`,
        },
        body: JSON.stringify({ email: "alice@x.y" }),
      })
    );
    const { code } = await cr.json();
    const dr = await app.handle(
      new Request(`http://localhost/api/auth/invites/${code}`, {
        method: "DELETE",
        headers: { authorization: `Bearer ${ownerJwt}` },
      })
    );
    expect(dr.status).toBe(204);
  });
});
