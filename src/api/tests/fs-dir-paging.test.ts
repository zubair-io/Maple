import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import * as path from "node:path";
import * as os from "node:os";
import * as fs from "node:fs/promises";

describe("GET /api/fs/dir paging", () => {
  let tmpRoot: string;
  let realTmpRoot: string;
  let small: string;
  let big: string;

  beforeAll(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "maple-fsdir-paging-"));
    realTmpRoot = await fs.realpath(tmpRoot);

    small = path.join(tmpRoot, "small");
    big = path.join(tmpRoot, "big");
    await fs.mkdir(small);
    await fs.mkdir(big);

    for (let i = 0; i < 200; i++) {
      await fs.writeFile(path.join(small, `IMG_${String(i).padStart(4, "0")}.dng`), "x");
    }
    for (let i = 0; i < 1200; i++) {
      await fs.writeFile(path.join(big, `IMG_${String(i).padStart(4, "0")}.dng`), "x");
    }

    process.env.MAPLE_ROOTS = realTmpRoot;
  });

  afterAll(async () => {
    delete process.env.MAPLE_ROOTS;
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  it("small dir without cursor returns single shot, no next_cursor", async () => {
    const { fsRoutes } = await import("../src/routes/fs.ts");
    const res = await fsRoutes.handle(
      new Request(`http://localhost/api/fs/dir?path=${encodeURIComponent(small)}`),
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.images.length).toBe(200);
    expect(json.next_cursor ?? null).toBeNull();
  });

  it("big dir paginates across three responses with default limit 500", async () => {
    const { fsRoutes } = await import("../src/routes/fs.ts");
    // First page (no cursor) — opt-in via &limit=500 so paged mode
    // engages without a cursor.
    const r1 = await fsRoutes.handle(
      new Request(
        `http://localhost/api/fs/dir?path=${encodeURIComponent(big)}&limit=500`,
      ),
    );
    expect(r1.status).toBe(200);
    const j1 = await r1.json();
    expect(j1.images.length).toBe(500);
    expect(typeof j1.next_cursor).toBe("string");

    // Second page (follow cursor).
    const r2 = await fsRoutes.handle(
      new Request(
        `http://localhost/api/fs/dir?path=${encodeURIComponent(big)}&cursor=${encodeURIComponent(j1.next_cursor)}`,
      ),
    );
    expect(r2.status).toBe(200);
    const j2 = await r2.json();
    expect(j2.images.length).toBe(500);
    expect(typeof j2.next_cursor).toBe("string");

    // Third (last) page.
    const r3 = await fsRoutes.handle(
      new Request(
        `http://localhost/api/fs/dir?path=${encodeURIComponent(big)}&cursor=${encodeURIComponent(j2.next_cursor)}`,
      ),
    );
    expect(r3.status).toBe(200);
    const j3 = await r3.json();
    expect(j3.images.length).toBe(200);
    expect(j3.next_cursor ?? null).toBeNull();

    // Union of names covers every file exactly once.
    const all = new Set<string>();
    for (const img of [...j1.images, ...j2.images, ...j3.images]) {
      expect(all.has(img.name)).toBe(false);
      all.add(img.name);
    }
    expect(all.size).toBe(1200);
  });

  it("invalid cursor returns 400", async () => {
    const { fsRoutes } = await import("../src/routes/fs.ts");
    const res = await fsRoutes.handle(
      new Request(
        `http://localhost/api/fs/dir?path=${encodeURIComponent(big)}&cursor=not-base64!!`,
      ),
    );
    expect(res.status).toBe(400);
  });

  it("limit > 2000 clamped to 2000", async () => {
    const { fsRoutes } = await import("../src/routes/fs.ts");
    const res = await fsRoutes.handle(
      new Request(
        `http://localhost/api/fs/dir?path=${encodeURIComponent(big)}&limit=5000`,
      ),
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    // Big dir has 1200 entries (< 2000 clamp) → all in one page, no cursor.
    expect(json.images.length).toBe(1200);
    expect(json.next_cursor ?? null).toBeNull();
  });
});
