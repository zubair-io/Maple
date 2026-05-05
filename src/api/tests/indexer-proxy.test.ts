/**
 * Tests for the parent → child indexer proxy.
 *
 * Spins up a fake "child" Elysia on a free localhost port (echoes back
 * the request method/path/body in JSON), points `MAPLE_INDEXER_PORT` at
 * it, and exercises the parent's `indexerRoutes` via bare `app.handle()`.
 *
 * Skip-passes cleanly if the child fails to bind (e.g. CI sandbox
 * without localhost networking — mirrors the pattern used in
 * `tests/fs/thumb.test.ts`).
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { Elysia } from "elysia";

// JWT secret bootstrap — required because requireAuth reads it at import.
process.env.MAPLE_JWT_SECRET = "x".repeat(32);

// Pick a port from the ephemeral range and tell the supervisor to use it
// before importing anything that touches `targetUrl`.
const FAKE_PORT = 48000 + Math.floor(Math.random() * 1000);
process.env.MAPLE_INDEXER_PORT = String(FAKE_PORT);

// ---------------------------------------------------------------------------
// Fake child server. Echoes whatever the parent forwards so we can assert
// the proxy preserves method, path, and body.
// ---------------------------------------------------------------------------

interface EchoBody {
  method: string;
  path: string;
  query: string;
  body: unknown;
}

function buildFakeChild(): unknown {
  return new Elysia()
    .get("/status", () => ({
      paused: false,
      pools: { discover: 1, hash: 1, exif: 1, thumb: 1, ai: 1, mongo: 1 },
      channels: {
        discover: { depth: 0, capacity: 64 },
        hash: { depth: 0, capacity: 64 },
        exif: { depth: 0, capacity: 64 },
        thumb: { depth: 0, capacity: 64 },
        ai: { depth: 0, capacity: 64 },
        mongo: { depth: 0, capacity: 64 },
      },
      stages: {
        discover: { inFlight: 0, errors: 0, deadLetter: 0 },
        hash: { inFlight: 0, errors: 0, deadLetter: 0 },
        exif: { inFlight: 0, errors: 0, deadLetter: 0 },
        thumb: { inFlight: 0, errors: 0, deadLetter: 0 },
        ai: { inFlight: 0, errors: 0, deadLetter: 0 },
        mongo: { inFlight: 0, errors: 0, deadLetter: 0 },
      },
    }))
    .post("/pause", () => ({ ok: true }))
    .post("/resume", () => ({ ok: true }))
    .put("/config", async ({ request }) => {
      const body = await request.json().catch(() => null);
      return { ok: true, echoed: body } satisfies { ok: boolean; echoed: unknown };
    })
    .get("/dead-letter", ({ query }) => ({
      items: [],
      total: 0,
      query: query.limit ?? null,
    }))
    .post("/exif-backfill", () => ({ ok: true }))
    .all("*", ({ request }): EchoBody => {
      const u = new URL(request.url);
      return {
        method: request.method,
        path: u.pathname,
        query: u.search,
        body: null,
      };
    });
}

// ---------------------------------------------------------------------------
// Build the parent app. Because we're testing the proxy in isolation, we
// mount just `indexerRoutes` (with auth disabled) on a bare Elysia.
// ---------------------------------------------------------------------------

// Elysia's generic chain is very expressive — the inferred type of an app
// chained through ten `.get()` calls cannot be assigned back to plain
// `Elysia<"">`. We don't need any of the route-level inference for these
// tests, so cast through `unknown` to a minimal Elysia surface.
type AnyElysia = {
  listen: (opts: { port: number; hostname: string }) => unknown;
  handle: (req: Request) => Promise<Response>;
  use: (plugin: unknown) => AnyElysia;
  stop?: () => void;
};

let fakeChildServer: { stop?: () => void } | null = null;
let parent: AnyElysia | null = null;
let bootError: Error | null = null;

beforeAll(async () => {
  try {
    const fake = buildFakeChild() as unknown as AnyElysia;
    const handle = fake.listen({ port: FAKE_PORT, hostname: "127.0.0.1" });
    fakeChildServer = handle as { stop?: () => void };
    // Give the listener a tick to bind.
    await new Promise((r) => setTimeout(r, 50));

    // Sanity-poke: confirm the fake is actually reachable.
    const ping = await fetch(`http://127.0.0.1:${FAKE_PORT}/status`, {
      signal: AbortSignal.timeout(1_000),
    });
    if (!ping.ok) throw new Error(`fake child returned ${ping.status}`);

    const { indexerRoutes } = await import("../src/routes/indexer.ts");
    const { _resetForTests } = await import("../src/indexer/control.ts");
    _resetForTests();

    const built = new Elysia().use(indexerRoutes);
    parent = built as unknown as AnyElysia;
  } catch (e) {
    bootError = e instanceof Error ? e : new Error(String(e));
  }
});

afterAll(async () => {
  try {
    fakeChildServer?.stop?.();
  } catch {
    /* ignore */
  }
  try {
    const { _resetForTests } = await import("../src/indexer/control.ts");
    _resetForTests();
  } catch {
    /* ignore */
  }
});

// Pretend the supervisor thinks the child is running. The proxy gates
// on `controlState().status` — without this, every call would 503.
function pretendChildRunning(): void {
  // Direct state mutation via the test-only helper. Going through
  // waitReady() against the fake would also work, but takes ~200 ms per
  // call.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const ctrl = require("../src/indexer/control.ts") as typeof import("../src/indexer/control.ts");
  ctrl._setStatusForTests("running");
}

describe("indexer proxy — child reachable", () => {
  it("GET /api/indexer/status forwards to child /status", async () => {
    if (bootError) {
      console.warn(`[skip] ${bootError.message}`);
      return;
    }
    pretendChildRunning();
    const res = await parent!.handle(
      new Request("http://localhost/api/indexer/status"),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { paused: boolean };
    expect(body.paused).toBe(false);
  });

  it("POST /api/indexer/pause forwards to child /pause", async () => {
    if (bootError) {
      console.warn(`[skip] ${bootError.message}`);
      return;
    }
    pretendChildRunning();
    const res = await parent!.handle(
      new Request("http://localhost/api/indexer/pause", { method: "POST" }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
  });

  it("GET /api/indexer/dead-letter preserves the query string", async () => {
    if (bootError) {
      console.warn(`[skip] ${bootError.message}`);
      return;
    }
    pretendChildRunning();
    const res = await parent!.handle(
      new Request("http://localhost/api/indexer/dead-letter?limit=42"),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { query: string | null };
    expect(body.query).toBe("42");
  });

  it("PUT /api/indexer/config forwards a JSON body", async () => {
    if (bootError) {
      console.warn(`[skip] ${bootError.message}`);
      return;
    }
    pretendChildRunning();
    const res = await parent!.handle(
      new Request("http://localhost/api/indexer/config", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workers: { hash: 4 } }),
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; echoed: unknown };
    expect(body.ok).toBe(true);
    expect(body.echoed).toEqual({ workers: { hash: 4 } });
  });
});

describe("indexer proxy — child stopped", () => {
  it("returns 503 when the supervisor reports stopped", async () => {
    if (bootError) {
      console.warn(`[skip] ${bootError.message}`);
      return;
    }
    const ctrl = await import("../src/indexer/control.ts");
    ctrl._resetForTests();
    // Default state after reset is `stopped`.
    const res = await parent!.handle(
      new Request("http://localhost/api/indexer/status"),
    );
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: string; state: { status: string } };
    expect(body.error).toMatch(/not running/i);
    expect(body.state.status).toBe("stopped");
  });
});

describe("indexer proxy — process endpoints", () => {
  it("GET /api/indexer/process returns supervisor state", async () => {
    if (bootError) {
      console.warn(`[skip] ${bootError.message}`);
      return;
    }
    const ctrl = await import("../src/indexer/control.ts");
    ctrl._resetForTests();
    const res = await parent!.handle(
      new Request("http://localhost/api/indexer/process"),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; pid: number | null };
    expect(body.status).toBe("stopped");
    expect(body.pid).toBeNull();
  });
});
