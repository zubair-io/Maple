import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Elysia } from "elysia";
import { mkdtemp, rm, writeFile, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDb } from "../db/client.ts";
import { fsRoutes } from "./fs.ts";

// The fs.etag route handler calls into listDirContents, which lazily
// initialises the shared MongoClient via assetsCollection(). The DB name
// is read once at connect time. To stay coherent with the other etag
// tests in this process (which target `maple_etag_test_<pid>`), pin the
// env var here too — otherwise the API caches a connection to the
// default `maple` DB and the other tests fail to see their seed data.
const SHARED_DB = `maple_etag_test_${process.pid}`;

describe("GET /api/fs/dir — ETag", () => {
  let tmp: string | null = null;

  beforeEach(async () => {
    process.env.MAPLE_MONGO_URI =
      process.env.MAPLE_MONGO_URI ?? "mongodb://localhost:27017";
    process.env.MAPLE_MONGO_DB = SHARED_DB;
    // Reset the API's module-cached MongoClient so the next route call
    // (which transitively calls assetsCollection via listDirContents)
    // picks up MAPLE_MONGO_DB fresh.
    await closeDb();
    tmp = await realpath(await mkdtemp(join(tmpdir(), "maple-fs-etag-")));
    process.env.MAPLE_ROOTS = tmp;
    await writeFile(join(tmp, "a.dng"), Buffer.alloc(8));
  });

  afterEach(async () => {
    if (tmp) await rm(tmp, { recursive: true, force: true }).catch(() => {});
    tmp = null;
    await closeDb();
  });


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
