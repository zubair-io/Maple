import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import * as path from "node:path";
import * as os from "node:os";
import * as fs from "node:fs/promises";

describe("listDir", () => {
  let tmpRoot: string;
  let realTmpRoot: string;

  beforeAll(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "maple-browse-"));
    // Resolve symlinks so assertions match the realpath form returned by listDir.
    realTmpRoot = await fs.realpath(tmpRoot);
    await fs.mkdir(path.join(tmpRoot, "photos"));
    await fs.mkdir(path.join(tmpRoot, "docs"));
    await fs.writeFile(path.join(tmpRoot, "readme.txt"), "x");
    await fs.mkdir(path.join(tmpRoot, ".hidden"));
  });

  afterAll(async () => {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  it("lists subdirectories of a real path", async () => {
    const { listDir } = await import("../src/fs/browse.ts");
    process.env.MAPLE_ROOTS = tmpRoot;
    const res = await listDir(tmpRoot, false);
    delete process.env.MAPLE_ROOTS;

    expect(res.ok).toBe(true);
    expect(res.data!.path).toBe(realTmpRoot);
    const names = res.data!.entries.map((e) => e.name).sort();
    expect(names).toEqual(["docs", "photos"]); // hidden + non-dirs filtered
  });

  it("rejects a path outside MAPLE_ROOTS", async () => {
    const { listDir } = await import("../src/fs/browse.ts");
    process.env.MAPLE_ROOTS = tmpRoot;
    const res = await listDir("/etc", false);
    delete process.env.MAPLE_ROOTS;

    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/outside.*MAPLE_ROOTS/i);
  });

  it("defaults MAPLE_ROOTS to '/' when unset", async () => {
    const { listDir } = await import("../src/fs/browse.ts");
    delete process.env.MAPLE_ROOTS;
    const res = await listDir(tmpRoot, false);
    expect(res.ok).toBe(true);
  });

  it("filters system directories at root when showAll=false", async () => {
    const { listDir } = await import("../src/fs/browse.ts");
    delete process.env.MAPLE_ROOTS;
    const res = await listDir("/", false);
    expect(res.ok).toBe(true);
    const names = res.data!.entries.map((e) => e.name);
    // None of the canonical system dirs should appear.
    for (const sys of ["proc", "sys", "dev", "etc", "var", "usr", "bin", "sbin"]) {
      expect(names).not.toContain(sys);
    }
  });

  it("returns system directories when showAll=true and they exist", async () => {
    const { listDir } = await import("../src/fs/browse.ts");
    delete process.env.MAPLE_ROOTS;
    const res = await listDir("/", true);
    expect(res.ok).toBe(true);
    // On any Unix, /etc exists. On macOS /etc is a symlink → still listed.
    const names = res.data!.entries.map((e) => e.name);
    expect(names).toContain("etc");
  });

  it("returns parent path for non-root directories", async () => {
    const { listDir } = await import("../src/fs/browse.ts");
    delete process.env.MAPLE_ROOTS;
    const res = await listDir(tmpRoot, false);
    expect(res.ok).toBe(true);
    expect(res.data!.parent).toBe(path.dirname(realTmpRoot));
  });

  it("returns null parent for filesystem root", async () => {
    const { listDir } = await import("../src/fs/browse.ts");
    delete process.env.MAPLE_ROOTS;
    const res = await listDir("/", false);
    expect(res.ok).toBe(true);
    expect(res.data!.parent).toBeNull();
  });
});
