/**
 * Tests for the request-id + uniform error envelope middleware.
 *
 * Covered:
 *   - X-Request-Id is generated when no inbound header is present (success path).
 *   - X-Request-Id is echoed verbatim when the client supplies one.
 *   - 404 from an unmatched route returns the canonical envelope shape.
 *   - A route that sets `set.status = 400; return { error: "..." }` (no throw)
 *     still lands as the envelope via mapResponse.
 *   - A thrown exception inside a route surfaces as `code: "internal"` 500
 *     and carries the request-id.
 *   - The legacy DB-unavailable carve-out keeps its 503 + `tip` semantic
 *     with `tip` at the top level (the existing operator UI reads it there).
 *
 * No MongoDB required — every case mounts a tiny Elysia app from
 * `requestContext` + an inline route, so this file runs in every CI
 * environment regardless of whether the DB fixtures are available.
 */

import { describe, test, expect } from "bun:test";
import { Elysia } from "elysia";
import { requestContext } from "../src/middleware/request-context.ts";

// Helper: mount a tiny Elysia app behind the requestContext plugin.
//
// Elysia's generic types track each chained route into the instance type;
// threading those generics through a factory closure requires more
// boilerplate than the test value justifies. The runtime behaviour is what
// we care about here, so we leak `any` deliberately at the boundary and
// the route handlers below are typed `(ctx: any)` for the same reason.
/* eslint-disable @typescript-eslint/no-explicit-any */
type AnyApp = any;
function appWith(builder: (a: AnyApp) => AnyApp): AnyApp {
  return builder(new Elysia().use(requestContext));
}
/* eslint-enable @typescript-eslint/no-explicit-any */

describe("requestContext: request-id header", () => {
  test("generates X-Request-Id on success when client omits it", async () => {
    const app = appWith((a) => a.get("/ok", () => ({ ok: true })));
    const res = await app.handle(new Request("http://localhost/ok"));
    expect(res.status).toBe(200);
    const id = res.headers.get("X-Request-Id");
    expect(id).toBeTruthy();
    // ULID shape: 26 chars of Crockford Base32 (issue #133).
    expect(id!).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
  });

  test("echoes client-supplied X-Request-Id verbatim", async () => {
    const app = appWith((a) => a.get("/ok", () => ({ ok: true })));
    const supplied = "client-supplied-abc-123";
    const res = await app.handle(
      new Request("http://localhost/ok", {
        headers: { "X-Request-Id": supplied },
      }),
    );
    expect(res.headers.get("X-Request-Id")).toBe(supplied);
  });

  test("requestId is available in the route via derive", async () => {
    const seenBox: { v: string | null } = { v: null };
    const app = appWith((a) =>
      a.get("/r", ({ requestId }: { requestId: string }) => {
        seenBox.v = requestId;
        return { requestId };
      }),
    );
    const supplied = "trace-xyz";
    const res = await app.handle(
      new Request("http://localhost/r", {
        headers: { "X-Request-Id": supplied },
      }),
    );
    const body = (await res.json()) as { requestId: string };
    expect(body.requestId).toBe(supplied);
    expect(seenBox.v).toBe(supplied);
  });
});

describe("requestContext: error envelope shape", () => {
  test("404 from unmatched route → envelope with code: not_found", async () => {
    const app = appWith((a) => a.get("/known", () => ({ ok: true })));
    const res = await app.handle(new Request("http://localhost/does-not-exist"));
    expect(res.status).toBe(404);
    const id = res.headers.get("X-Request-Id");
    expect(id).toBeTruthy();
    const body = (await res.json()) as Record<string, unknown>;
    expect(typeof body.error).toBe("string");
    expect(body.code).toBe("not_found");
    expect(body.requestId).toBe(id);
  });

  test("set.status=400 + return { error } → envelope via mapResponse", async () => {
    const app = appWith((a) =>
      a.get("/bad", ({ set }: { set: { status: number } }) => {
        set.status = 400;
        return { error: "missing param" };
      }),
    );
    const res = await app.handle(new Request("http://localhost/bad"));
    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe("missing param");
    expect(body.code).toBe("bad_request");
    expect(typeof body.requestId).toBe("string");
    expect(body.requestId).toBe(res.headers.get("X-Request-Id"));
  });

  test("status=409 → code: conflict", async () => {
    const app = appWith((a) =>
      a.get("/c", ({ set }: { set: { status: number } }) => {
        set.status = 409;
        return { error: "duplicate" };
      }),
    );
    const res = await app.handle(new Request("http://localhost/c"));
    expect(res.status).toBe(409);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.code).toBe("conflict");
  });

  test("status=403 → code: forbidden", async () => {
    const app = appWith((a) =>
      a.get("/f", ({ set }: { set: { status: number } }) => {
        set.status = 403;
        return { error: "nope" };
      }),
    );
    const res = await app.handle(new Request("http://localhost/f"));
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.code).toBe("forbidden");
  });

  test("status=415 → code: unsupported_media_type", async () => {
    const app = appWith((a) =>
      a.get("/u", ({ set }: { set: { status: number } }) => {
        set.status = 415;
        return { error: "bad type" };
      }),
    );
    const res = await app.handle(new Request("http://localhost/u"));
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.code).toBe("unsupported_media_type");
  });

  test("set.status=401 + throw → envelope preserves 401 and code: unauthorized", async () => {
    const app = appWith((a) =>
      a.get("/secret", ({ set }: { set: { status: number } }) => {
        set.status = 401;
        throw new Error("missing bearer");
      }),
    );
    const res = await app.handle(new Request("http://localhost/secret"));
    expect(res.status).toBe(401);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe("missing bearer");
    expect(body.code).toBe("unauthorized");
    expect(typeof body.requestId).toBe("string");
  });
});

describe("requestContext: uncaught error → internal envelope", () => {
  test("plain throw → 500 + code: internal + requestId logged", async () => {
    const app = appWith((a) =>
      a.get("/boom", () => {
        throw new Error("kaboom");
      }),
    );
    const supplied = "boom-trace-id";
    const res = await app.handle(
      new Request("http://localhost/boom", {
        headers: { "X-Request-Id": supplied },
      }),
    );
    expect(res.status).toBe(500);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe("kaboom");
    expect(body.code).toBe("internal");
    expect(body.requestId).toBe(supplied);
  });

  test("DB-unavailable carve-out: '[db]' in message → 503 + service_unavailable + tip", async () => {
    const app = appWith((a) =>
      a.get("/db", () => {
        throw new Error("[db] MongoDB connection refused");
      }),
    );
    const res = await app.handle(new Request("http://localhost/db"));
    expect(res.status).toBe(503);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.code).toBe("service_unavailable");
    expect(body.error).toBe("Database unavailable");
    // Backwards-compat carve-out: `tip` stays at the top level so existing
    // operator UI can read it. New clients are free to ignore it.
    expect(body.tip).toMatch(/docker compose up.*mongo/i);
  });
});

describe("requestContext: 2xx pass-through", () => {
  test("does NOT wrap success bodies", async () => {
    const app = appWith((a) => a.get("/ok", () => ({ data: 42 })));
    const res = await app.handle(new Request("http://localhost/ok"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toEqual({ data: 42 });
    // The request-id header is still attached on success too.
    expect(res.headers.get("X-Request-Id")).toBeTruthy();
  });
});

describe("requestContext: integration via buildApp()", () => {
  // The unit tests above mount routes flat on the plugin. This case
  // verifies the plugin's hooks actually reach the authed-API sub-tree,
  // which is wrapped in a named child Elysia (`new Elysia({ name: "authedApi" })`)
  // — the most error-prone composition in the codebase. If `.as("global")`
  // were broken, this test would fail because `requireAuth` throws before
  // any error handler local to the sub-tree had a chance to fire.
  test("/api/folders without bearer → 401 envelope with X-Request-Id", async () => {
    // Set a JWT secret so requireAuth doesn't blow up at module load.
    process.env.MAPLE_JWT_SECRET = "x".repeat(32);
    const { buildApp } = await import("../src/index.ts");
    const app = buildApp();
    const res = await app.handle(
      new Request("http://localhost/api/folders", {
        headers: { "X-Request-Id": "integration-test-id" },
      }),
    );
    expect(res.status).toBe(401);
    expect(res.headers.get("X-Request-Id")).toBe("integration-test-id");
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.code).toBe("unauthorized");
    expect(body.requestId).toBe("integration-test-id");
    expect(typeof body.error).toBe("string");
  });
});

describe("requestContext: raw Response wrapping (fix for static-UI 403)", () => {
  test("non-JSON error Response (e.g. `new Response('Forbidden', { status: 403 })`) is wrapped into the envelope", async () => {
    const app = appWith((a) =>
      a.get("/forbidden", () => new Response("Forbidden", { status: 403 })),
    );
    const res = await app.handle(new Request("http://localhost/forbidden"));
    expect(res.status).toBe(403);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe("Forbidden");
    expect(body.code).toBe("forbidden");
    expect(typeof body.requestId).toBe("string");
    expect(body.requestId).toBe(res.headers.get("X-Request-Id"));
    expect(res.headers.get("content-type") ?? "").toMatch(/json/i);
  });

  test("2xx raw Response is passed through unchanged", async () => {
    const app = appWith((a) =>
      a.get("/file", () =>
        new Response("hello", {
          status: 200,
          headers: { "Content-Type": "text/plain" },
        }),
      ),
    );
    const res = await app.handle(new Request("http://localhost/file"));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("hello");
    expect(res.headers.get("content-type") ?? "").toMatch(/text\/plain/);
  });

  test("3xx redirect Response is passed through (no wrap)", async () => {
    const app = appWith((a) =>
      a.get("/r", () =>
        new Response(null, {
          status: 302,
          headers: { Location: "/elsewhere" },
        }),
      ),
    );
    const res = await app.handle(new Request("http://localhost/r"));
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/elsewhere");
  });

  test("JSON-typed raw error Response is NOT double-wrapped", async () => {
    const app = appWith((a) =>
      a.get("/j", () =>
        new Response(JSON.stringify({ already: "shaped" }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );
    const res = await app.handle(new Request("http://localhost/j"));
    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toEqual({ already: "shaped" });
  });
});

describe("requestContext: concurrency safety", () => {
  test("100 concurrent requests with distinct supplied ids each echo their own id (no cross-talk)", async () => {
    // The previous implementation stashed requestId on the plugin-shared
    // `store` object; concurrent in-flight requests would overwrite each
    // other so `mapResponse` returned the wrong id in the body. Reproduce
    // a realistic interleaving by yielding inside the route handler.
    const app = appWith((a) =>
      a.get(
        "/concurrent",
        async ({ set }: { set: { status: number } }) => {
          await new Promise((r) => setTimeout(r, Math.random() * 5));
          set.status = 400;
          return { error: "bad" };
        },
      ),
    );

    const N = 100;
    const results = await Promise.all(
      Array.from({ length: N }, (_, i) => {
        const supplied = `concurrent-req-${i}`;
        return app
          .handle(
            new Request("http://localhost/concurrent", {
              headers: { "X-Request-Id": supplied },
            }),
          )
          .then(async (res: Response) => {
            const body = (await res.json()) as Record<string, unknown>;
            return {
              supplied,
              header: res.headers.get("X-Request-Id"),
              bodyId: body.requestId,
            };
          });
      }),
    );

    for (const r of results) {
      expect(r.header).toBe(r.supplied);
      expect(r.bodyId).toBe(r.supplied);
    }
  });
});

describe("requestContext: top-level extras preserved (backwards-compat)", () => {
  test("legacy `{ error, ...rest }` shape keeps extras at top-level", async () => {
    // Several existing routes return e.g. `{ error: "...", expected_offset: N }`
    // or `{ error: "...", retry_after_seconds: N }` and Apple/Web clients
    // read those at the top level. The middleware MUST NOT relocate them,
    // or it breaks the public contract. It just adds `code` + `requestId`
    // alongside the existing keys.
    const app = appWith((a) =>
      a.get("/legacy", ({ set }: { set: { status: number } }) => {
        set.status = 409;
        return { error: "resume offset mismatch", expected_offset: 1024 };
      }),
    );
    const res = await app.handle(new Request("http://localhost/legacy"));
    expect(res.status).toBe(409);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe("resume offset mismatch");
    expect(body.code).toBe("conflict");
    expect(typeof body.requestId).toBe("string");
    expect(body.expected_offset).toBe(1024);
  });
});
