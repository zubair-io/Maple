import { afterEach, describe, expect, it } from "bun:test";
import {
  Supervisor,
  setSupervisorSingleton,
  startSupervisor,
  stopSupervisor,
  supervisorState,
} from "./supervisor.ts";

// Helper: write a tiny Bun script to a temp file, return the path.
async function writeTmpScript(body: string): Promise<string> {
  const { mkdtemp, writeFile } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const os = await import("node:os");
  const dir = await mkdtemp(join(os.tmpdir(), "maple-sup-"));
  const p = join(dir, "stage.ts");
  await writeFile(p, body);
  return p;
}

describe("Supervisor — lifecycle", () => {
  let sup: Supervisor;

  afterEach(async () => {
    await sup?.stopAll();
  });

  it("starts with no children when stageNames is empty", () => {
    sup = new Supervisor([]);
    expect(sup.statuses()).toEqual({});
  });

  it("reports error status after 5 consecutive crashes", async () => {
    // Script that always exits 1
    const script = await writeTmpScript(`process.exit(1);\n`);
    sup = new Supervisor([], {
      _stageScriptOverrides: { crashing: script },
      _backoffMsOverride: [50, 50, 50, 50, 50],
    });
    sup.addStage("crashing");

    await new Promise<void>((resolve) => {
      const check = setInterval(() => {
        const s = sup.statuses();
        if (s.crashing?.status === "error") {
          clearInterval(check);
          resolve();
        }
      }, 100);
      setTimeout(() => { clearInterval(check); resolve(); }, 8000);
    });

    expect(sup.statuses().crashing?.status).toBe("error");
  }, 10_000);

  it("spawns and reaches running status for a healthy stage", async () => {
    const script = await writeTmpScript(`
const { serve } = Bun;
const port = parseInt(process.env.MAPLE_STAGE_PORT ?? "0");
serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch(req) {
    if (new URL(req.url).pathname === "/status") {
      return Response.json({ status: "running", inFlight: 0, throughput: 0 });
    }
    return new Response("not found", { status: 404 });
  },
});
process.stdout.write("__MAPLE_READY__\\n");
await new Promise(() => {}); // keep alive
`);
    sup = new Supervisor([], { _stageScriptOverrides: { healthy: script }, readyTimeoutMs: 5000 });
    sup.addStage("healthy");

    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("timeout")), 6000);
      const check = setInterval(() => {
        if (sup.statuses().healthy?.status === "running") {
          clearInterval(check);
          clearTimeout(t);
          resolve();
        }
      }, 100);
    });

    expect(sup.statuses().healthy?.status).toBe("running");
  }, 8_000);
});

describe("Supervisor — refreshLiveStatus", () => {
  let sup: Supervisor;

  afterEach(async () => {
    await sup?.stopAll();
  });

  it("refreshes inFlight + throughput from a running child's IPC /status", async () => {
    // Script emulates a long-lived stage child: starts an IPC server, prints
    // the port (the supervisor's __MAPLE_IPC_PORT__ contract), then idles.
    // /status returns inFlight=3, throughput=42 — non-zero so we can prove
    // the refresh wrote the response into m.state.
    const script = await writeTmpScript(`
const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch(req) {
    if (new URL(req.url).pathname === "/status") {
      return Response.json({ status: "running", inFlight: 3, throughput: 42, targetVersion: 7 });
    }
    return new Response("not found", { status: 404 });
  },
});
process.stdout.write(\`__MAPLE_IPC_PORT__=\${server.port}\\n\`);
await new Promise(() => {}); // keep alive
`);
    sup = new Supervisor([], { _stageScriptOverrides: { live: script }, readyTimeoutMs: 5000 });
    sup.addStage("live");

    // Wait until the supervisor parses the IPC port from stdout.
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("timeout waiting for running")), 6000);
      const check = setInterval(() => {
        if (sup.statuses().live?.status === "running") {
          clearInterval(check);
          clearTimeout(t);
          resolve();
        }
      }, 50);
    });

    // Force the supervisor's cached values to known-stale before the refresh
    // so we can detect that refreshLiveStatus actually wrote new data.
    const before = sup.statuses().live!;
    expect(before.status).toBe("running");

    await sup.refreshLiveStatus();

    const after = sup.statuses().live!;
    expect(after.inFlight).toBe(3);
    expect(after.throughput).toBe(42);
    expect(after.targetVersion).toBe(7);
  }, 10_000);
});

describe("Supervisor — pause/resume IPC", () => {
  it("returns error for unknown stage", async () => {
    const sup = new Supervisor([]);
    const result = await sup.pause("nonexistent");
    expect(result.ok).toBe(false);
  });
});

describe("Supervisor — notifyConfigChanged", () => {
  it("returns error for unknown stage", async () => {
    const sup = new Supervisor([]);
    const result = await sup.notifyConfigChanged("nonexistent");
    expect(result.ok).toBe(false);
  });
});

describe("startSupervisor — singleton reuse", () => {
  afterEach(async () => {
    await stopSupervisor();
  });

  it("adds stages to a pre-registered empty singleton (buildApp boot path)", async () => {
    // Mimic index.ts: buildApp() constructs an empty Supervisor and registers
    // it as the singleton before Mongo connects. The deferred startSupervisor
    // call carries the real stage list and must populate the existing
    // supervisor instead of silently discarding it.
    const empty = new Supervisor([]);
    setSupervisorSingleton(empty);
    expect(supervisorState()).toEqual({});

    // Use a stage script that immediately exits — we only care that addStage
    // was invoked, not that the child reaches "running". The crash backoff
    // keeps `restarting`/`error` set rather than the stage disappearing.
    const { mkdtemp, writeFile } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const os = await import("node:os");
    const dir = await mkdtemp(join(os.tmpdir(), "maple-sup-singleton-"));
    const script = join(dir, "stage.ts");
    await writeFile(script, `process.exit(1);\n`);

    await startSupervisor({
      stages: ["alpha", "beta"],
      _stageScriptOverrides: { alpha: script, beta: script },
      _backoffMsOverride: [60_000],
    });

    const names = Object.keys(supervisorState()).sort();
    expect(names).toEqual(["alpha", "beta"]);
  }, 10_000);
});
