/**
 * Tests for the supervisor in `src/indexer/control.ts`.
 *
 * These exercise the *real* spawn path against the actual
 * `standalone.ts` entrypoint. The standalone tries to open a Mongo
 * connection on boot, so we skip-pass the spawn tests when Mongo isn't
 * reachable (mirrors the pattern in `tests/fs/thumb.test.ts`).
 *
 * Pure-state tests (e.g. _resetForTests semantics) always run.
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";

process.env.MAPLE_JWT_SECRET = "x".repeat(32);

// Pick a child port outside the normal default to avoid colliding with a
// dev server that might be running locally.
const CHILD_PORT = 49100 + Math.floor(Math.random() * 500);
process.env.MAPLE_INDEXER_PORT = String(CHILD_PORT);

let mongoOnline = false;

async function probeMongo(): Promise<boolean> {
  try {
    const { getDb } = await import("../src/db/client.ts");
    await getDb();
    return true;
  } catch {
    return false;
  }
}

beforeAll(async () => {
  mongoOnline = await probeMongo();
  if (!mongoOnline) {
    console.warn(
      "[skip] Mongo offline — supervisor spawn tests will skip-pass.",
    );
  }
});

afterAll(async () => {
  // Make sure no stray child is left over.
  try {
    const { stopChild, _resetForTests } = await import(
      "../src/indexer/control.ts"
    );
    await stopChild({ graceful: false });
    _resetForTests();
  } catch {
    /* ignore */
  }
  try {
    const { closeDb } = await import("../src/db/client.ts");
    await closeDb();
  } catch {
    /* ignore */
  }
});

describe("supervisor — pure state", () => {
  it("starts in `stopped` and round-trips through _resetForTests", async () => {
    const { state, _resetForTests, _setStatusForTests } = await import(
      "../src/indexer/control.ts"
    );
    _resetForTests();
    expect(state().status).toBe("stopped");
    _setStatusForTests("running");
    expect(state().status).toBe("running");
    _resetForTests();
    expect(state().status).toBe("stopped");
    expect(state().pid).toBeNull();
  });

  it("targetUrl honours MAPLE_INDEXER_PORT", async () => {
    const { targetUrl } = await import("../src/indexer/control.ts");
    expect(targetUrl("/status")).toBe(`http://127.0.0.1:${CHILD_PORT}/status`);
    expect(targetUrl("status")).toBe(`http://127.0.0.1:${CHILD_PORT}/status`);
  });
});

describe("supervisor — spawn against real standalone.ts", () => {
  it("spawnChild + waitReady transitions to `running`, stopChild back to `stopped`", async () => {
    if (!mongoOnline) {
      console.warn("[skip] mongo offline");
      return;
    }
    const { spawnChild, stopChild, waitReady, state, _resetForTests } =
      await import("../src/indexer/control.ts");

    _resetForTests();
    spawnChild();
    expect(["starting", "restarting"]).toContain(state().status);

    await waitReady(15_000);
    expect(state().status).toBe("running");
    expect(state().pid).toBeGreaterThan(0);

    await stopChild({ graceful: true });
    expect(state().status).toBe("stopped");
    expect(state().pid).toBeNull();
  }, 30_000);

  it("kills externally → status becomes `crashed` and auto-respawns", async () => {
    if (!mongoOnline) {
      console.warn("[skip] mongo offline");
      return;
    }
    const { spawnChild, stopChild, waitReady, state, _resetForTests } =
      await import("../src/indexer/control.ts");

    _resetForTests();
    spawnChild();
    await waitReady(15_000);
    const firstPid = state().pid!;
    expect(firstPid).toBeGreaterThan(0);

    // Externally kill the child. We do NOT call stopChild here — the
    // supervisor should observe the exit, mark crashed, and schedule
    // a respawn (1 s backoff for first crash).
    process.kill(firstPid, "SIGKILL");

    // Wait for the supervisor to flip to `crashed`.
    const startWait = Date.now();
    while (state().status !== "crashed" && Date.now() - startWait < 5_000) {
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(state().status).toBe("crashed");
    expect(state().lastExitCode).not.toBeNull();

    // Wait for auto-respawn — backoff is 1000 ms then waitReady polls.
    const respawnWait = Date.now();
    while (state().status !== "running" && Date.now() - respawnWait < 30_000) {
      await new Promise((r) => setTimeout(r, 200));
      // Poll the child manually because the supervisor doesn't run
      // waitReady automatically — re-arm it once we see `starting`.
      if (state().status === "starting" || state().status === "restarting") {
        try {
          await waitReady(2_000);
        } catch {
          /* try again */
        }
      }
    }

    expect(state().status).toBe("running");
    expect(state().pid).not.toBe(firstPid);

    await stopChild({ graceful: true });
    expect(state().status).toBe("stopped");
  }, 60_000);
});
