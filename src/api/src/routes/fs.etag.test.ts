import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { Elysia } from "elysia";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fsRoutes } from "./fs.ts";

let tmp: string | null = null;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "maple-fs-etag-"));
  process.env.MAPLE_ROOTS = tmp;
  await writeFile(join(tmp, "a.dng"), Buffer.alloc(8));
});

afterAll(async () => {
  if (tmp) await rm(tmp, { recursive: true, force: true });
});

describe("GET /api/fs/dir — ETag", () => {
  it("returns ETag on 200", async () => {
    const app = new Elysia().use(fsRoutes);
    const res = await app.handle(
      new Request(`http://localhost/api/fs/dir?path=${encodeURIComponent(tmp!)}`),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("ETag")).toMatch(/^"[a-f0-9]+"$/);
  });

  it("returns 304 when If-None-Match matches", async () => {
    const app = new Elysia().use(fsRoutes);
    const first = await app.handle(
      new Request(`http://localhost/api/fs/dir?path=${encodeURIComponent(tmp!)}`),
    );
    const etag = first.headers.get("ETag")!;
    const second = await app.handle(
      new Request(`http://localhost/api/fs/dir?path=${encodeURIComponent(tmp!)}`, {
        headers: { "If-None-Match": etag },
      }),
    );
    expect(second.status).toBe(304);
  });

  it("returns 200 with a new ETag when contents change", async () => {
    const app = new Elysia().use(fsRoutes);
    const first = await app.handle(
      new Request(`http://localhost/api/fs/dir?path=${encodeURIComponent(tmp!)}`),
    );
    const etag1 = first.headers.get("ETag")!;
    await writeFile(join(tmp!, "b.dng"), Buffer.alloc(8));
    const second = await app.handle(
      new Request(`http://localhost/api/fs/dir?path=${encodeURIComponent(tmp!)}`, {
        headers: { "If-None-Match": etag1 },
      }),
    );
    expect(second.status).toBe(200);
    expect(second.headers.get("ETag")).not.toBe(etag1);
  });
});
