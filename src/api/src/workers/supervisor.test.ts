import { afterEach, describe, expect, it } from "bun:test";
import { Supervisor } from "./supervisor.ts";

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
