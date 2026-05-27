import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import * as path from "node:path";
import * as os from "node:os";
import * as fs from "node:fs/promises";

// These tests intentionally exercise the `listDir` default-roots path (no
// MAPLE_ROOTS set — jail defaults to `/`). Other describe blocks in the suite
// pin MAPLE_ROOTS to their own tmp dir; if one of them runs first and forgets
// to restore (or restores incorrectly), our queries against `tmpRoot` and `/`
// fall outside that pinned root and `listDir` returns 400. Capture the prior
// value, force-clear for our setup, and restore in teardown so the file is
// hermetic regardless of run order (#546).
const PRIOR_MAPLE_ROOTS = process.env.MAPLE_ROOTS;

describe("GET /api/fs/list", () => {
  let tmpRoot: string;
  let realTmpRoot: string;

  beforeAll(async () => {
    // Force-clear so the jail defaults to `/` for these tests, regardless of
    // any value leaked from a prior describe in the same Bun process.
    delete process.env.MAPLE_ROOTS;
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "maple-fsroute-"));
    // Resolve symlinks so assertions match the realpath form returned by listDir.
    realTmpRoot = await fs.realpath(tmpRoot);
    await fs.mkdir(path.join(tmpRoot, "photos"));
  });

  afterAll(async () => {
    await fs.rm(tmpRoot, { recursive: true, force: true });
    if (PRIOR_MAPLE_ROOTS === undefined) delete process.env.MAPLE_ROOTS;
    else process.env.MAPLE_ROOTS = PRIOR_MAPLE_ROOTS;
  });

  it("returns a JSON listing for a valid path", async () => {
    const { fsRoutes } = await import("../src/routes/fs.ts");
    const app = fsRoutes;
    const res = await app.handle(
      new Request(
        `http://localhost/api/fs/list?path=${encodeURIComponent(tmpRoot)}`,
      ),
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.path).toBe(realTmpRoot);
    expect(Array.isArray(json.entries)).toBe(true);
    expect(json.entries.find((e: any) => e.name === "photos")).toBeDefined();
  });

  it("422s on a missing path query param", async () => {
    const { fsRoutes } = await import("../src/routes/fs.ts");
    const res = await fsRoutes.handle(
      new Request("http://localhost/api/fs/list"),
    );
    // Elysia returns 422 for schema validation failures (missing required field).
    expect(res.status).toBe(422);
  });

  it("400s on a relative path", async () => {
    const { fsRoutes } = await import("../src/routes/fs.ts");
    const res = await fsRoutes.handle(
      new Request("http://localhost/api/fs/list?path=relative/path"),
    );
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toMatch(/absolute/i);
  });

  it("respects showAll=1", async () => {
    const { fsRoutes } = await import("../src/routes/fs.ts");
    const res = await fsRoutes.handle(
      new Request("http://localhost/api/fs/list?path=/&showAll=1"),
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    // /etc exists on macOS and Linux; with showAll=1 it's included.
    expect(json.entries.some((e: any) => e.name === "etc")).toBe(true);
  });
});
