// src/api/tests/auth/routes.credentials.test.ts
import { describe, it, expect, beforeEach } from "bun:test";
import { Elysia } from "elysia";
import { ObjectId } from "mongodb";
import { authRoutes } from "../../src/routes/auth.ts";
import { signAccessToken } from "../../src/auth/tokens.ts";
import { credentialsCollection, usersCollection } from "../../src/db/client.ts";

process.env.MAPLE_JWT_SECRET = "x".repeat(32);
const app = new Elysia().use(authRoutes);

let userId: ObjectId;
let jwt: string;

beforeEach(async () => {
  await (await usersCollection()).deleteMany({});
  await (await credentialsCollection()).deleteMany({});
  const ins = await (await usersCollection()).insertOne({
    email: "u@m.c",
    role: "member",
    created_at: new Date().toISOString(),
    last_seen_at: null,
  });
  userId = ins.insertedId;
  jwt = signAccessToken(
    { sub: userId.toHexString(), email: "u@m.c", role: "member" },
    "x".repeat(32)
  );
});

describe("credentials", () => {
  it("returns 409 when removing the last credential", async () => {
    const credIns = await (await credentialsCollection()).insertOne({
      user_id: userId,
      credential_id: "c1",
      public_key: Buffer.from("k"),
      counter: 0,
      transports: [],
      device_label: "iPhone",
      created_at: new Date().toISOString(),
      last_used_at: null,
    });
    const r = await app.handle(
      new Request(
        `http://localhost/api/auth/credentials/${credIns.insertedId.toHexString()}`,
        {
          method: "DELETE",
          headers: { authorization: `Bearer ${jwt}` },
        }
      )
    );
    expect(r.status).toBe(409);
  });

  it("removes a credential when more than one exists", async () => {
    const a = await (await credentialsCollection()).insertOne({
      user_id: userId,
      credential_id: "c1",
      public_key: Buffer.from("k"),
      counter: 0,
      transports: [],
      device_label: "iPhone",
      created_at: new Date().toISOString(),
      last_used_at: null,
    });
    await (await credentialsCollection()).insertOne({
      user_id: userId,
      credential_id: "c2",
      public_key: Buffer.from("k"),
      counter: 0,
      transports: [],
      device_label: "Mac",
      created_at: new Date().toISOString(),
      last_used_at: null,
    });
    const r = await app.handle(
      new Request(
        `http://localhost/api/auth/credentials/${a.insertedId.toHexString()}`,
        {
          method: "DELETE",
          headers: { authorization: `Bearer ${jwt}` },
        }
      )
    );
    expect(r.status).toBe(204);
  });

  it("/me returns credentials list", async () => {
    await (await credentialsCollection()).insertOne({
      user_id: userId,
      credential_id: "c1",
      public_key: Buffer.from("k"),
      counter: 0,
      transports: [],
      device_label: "iPhone",
      created_at: new Date().toISOString(),
      last_used_at: null,
    });
    const r = await app.handle(
      new Request("http://localhost/api/auth/me", {
        headers: { authorization: `Bearer ${jwt}` },
      })
    );
    const body = await r.json();
    expect(body.credentials).toHaveLength(1);
    expect(body.credentials[0].device_label).toBe("iPhone");
  });
});
