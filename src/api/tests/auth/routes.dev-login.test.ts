import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Elysia } from "elysia";
import {
  usersCollection,
  refreshTokensCollection,
  challengesCollection,
} from "../../src/db/client.ts";

process.env.MAPLE_JWT_SECRET = "x".repeat(32);

async function freshAppWith(devAuth: "1" | undefined): Promise<Elysia> {
  // Re-import the routes module after toggling the env var so the
  // route handlers observe the current value (they read process.env
  // on each request, so a fresh import isn't strictly needed — but
  // building a fresh Elysia keeps the tests independent).
  if (devAuth === undefined) delete process.env.MAPLE_DEV_AUTH;
  else process.env.MAPLE_DEV_AUTH = devAuth;
  const { authRoutes } = await import("../../src/routes/auth.ts");
  return new Elysia().use(authRoutes);
}

beforeEach(async () => {
  for (const c of [usersCollection, refreshTokensCollection, challengesCollection]) {
    await (await c()).deleteMany({});
  }
});

afterEach(() => {
  delete process.env.MAPLE_DEV_AUTH;
});

describe("dev-login (gated)", () => {
  it("bootstrap reports dev_login_enabled=false by default", async () => {
    const app = await freshAppWith(undefined);
    const r = await app.handle(new Request("http://localhost/api/auth/bootstrap"));
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ claimed: false, dev_login_enabled: false });
  });

  it("bootstrap reports dev_login_enabled=true when env set", async () => {
    const app = await freshAppWith("1");
    const r = await app.handle(new Request("http://localhost/api/auth/bootstrap"));
    expect(await r.json()).toEqual({ claimed: false, dev_login_enabled: true });
  });

  it("returns 404 when MAPLE_DEV_AUTH is unset", async () => {
    const app = await freshAppWith(undefined);
    const r = await app.handle(
      new Request("http://localhost/api/auth/dev-login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      }),
    );
    expect(r.status).toBe(404);
  });

  it("creates the default dev user on first call when enabled", async () => {
    const app = await freshAppWith("1");
    const r = await app.handle(
      new Request("http://localhost/api/auth/dev-login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      }),
    );
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.access_token).toBeTypeOf("string");
    expect(body.refresh_token).toBeTypeOf("string");
    expect(body.user.email).toBe("dev@maple.local");
    expect(body.user.role).toBe("owner");

    const u = await (await usersCollection()).findOne({ email: "dev@maple.local" });
    expect(u).not.toBeNull();
    expect(u?.role).toBe("owner");
  });

  it("reuses the user on subsequent calls", async () => {
    const app = await freshAppWith("1");
    const first = await app
      .handle(
        new Request("http://localhost/api/auth/dev-login", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({}),
        }),
      )
      .then((r) => r.json());
    const second = await app
      .handle(
        new Request("http://localhost/api/auth/dev-login", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({}),
        }),
      )
      .then((r) => r.json());
    expect(second.user.id).toBe(first.user.id);
    const count = await (await usersCollection()).countDocuments({
      email: "dev@maple.local",
    });
    expect(count).toBe(1);
  });

  it("honours a custom email", async () => {
    const app = await freshAppWith("1");
    const r = await app.handle(
      new Request("http://localhost/api/auth/dev-login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "custom@dev.local" }),
      }),
    );
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.user.email).toBe("custom@dev.local");
  });
});
