import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Elysia } from "elysia";
import { MongoClient, type Db } from "mongodb";
import { closeDb } from "../db/client.ts";
import { renderConfigRoutes } from "./render-config.ts";

const MONGO_URI = process.env.MAPLE_MONGO_URI ?? "mongodb://localhost:27017";
const TEST_DB = `maple_render_config_test_${process.pid}`;

interface ResolvedBody {
  gpu_live_render_enabled: boolean;
  source: { gpu_live_render_enabled: "db" | "default" };
}

async function tryConnect(): Promise<MongoClient | null> {
  const c = new MongoClient(MONGO_URI, {
    serverSelectionTimeoutMS: 1_500,
    connectTimeoutMS: 1_500,
  });
  try {
    await c.connect();
    await c.db("admin").command({ ping: 1 });
    return c;
  } catch {
    try {
      await c.close();
    } catch {}
    return null;
  }
}

describe("/api/render/config", () => {
  let mongo: MongoClient | null = null;
  let db: Db | null = null;

  beforeEach(async () => {
    mongo = await tryConnect();
    if (!mongo) return;
    process.env.MAPLE_MONGO_URI = MONGO_URI;
    process.env.MAPLE_MONGO_DB = TEST_DB;
    await closeDb();
    db = mongo.db(TEST_DB);
    await db.dropDatabase();
  });

  afterEach(async () => {
    if (db) await db.dropDatabase().catch(() => {});
    if (mongo) await mongo.close().catch(() => {});
    await closeDb();
    db = null;
    mongo = null;
  });

  function app() {
    return new Elysia().use(renderConfigRoutes);
  }

  async function getConfig(): Promise<ResolvedBody> {
    const res = await app().handle(
      new Request("http://localhost/api/render/config"),
    );
    expect(res.status).toBe(200);
    return (await res.json()) as ResolvedBody;
  }

  async function putConfig(body: unknown): Promise<Response> {
    return app().handle(
      new Request("http://localhost/api/render/config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
  }

  it("GET returns the default (GPU live render on) on a fresh database", async () => {
    if (!db) return;
    const body = await getConfig();
    expect(body.gpu_live_render_enabled).toBe(true);
    expect(body.source.gpu_live_render_enabled).toBe("default");
  });

  it("PUT false kills GPU live render and GET reports it as db-sourced", async () => {
    if (!db) return;
    const res = await putConfig({ gpu_live_render_enabled: false });
    expect(res.status).toBe(200);
    const saved = (await res.json()) as ResolvedBody;
    expect(saved.gpu_live_render_enabled).toBe(false);

    const body = await getConfig();
    expect(body.gpu_live_render_enabled).toBe(false);
    expect(body.source.gpu_live_render_enabled).toBe("db");
  });

  it("PUT true ramps it back on", async () => {
    if (!db) return;
    await putConfig({ gpu_live_render_enabled: false });
    await putConfig({ gpu_live_render_enabled: true });
    const body = await getConfig();
    expect(body.gpu_live_render_enabled).toBe(true);
    expect(body.source.gpu_live_render_enabled).toBe("db");
  });

  it("PUT null clears the saved value back to the default", async () => {
    if (!db) return;
    await putConfig({ gpu_live_render_enabled: false });
    await putConfig({ gpu_live_render_enabled: null });
    const body = await getConfig();
    expect(body.gpu_live_render_enabled).toBe(true);
    expect(body.source.gpu_live_render_enabled).toBe("default");
  });

  it("PUT with the field omitted leaves the saved value alone", async () => {
    if (!db) return;
    await putConfig({ gpu_live_render_enabled: false });
    const res = await putConfig({});
    expect(res.status).toBe(200);
    const body = await getConfig();
    expect(body.gpu_live_render_enabled).toBe(false);
  });

  it('persists to app_settings under _id "render"', async () => {
    if (!db) return;
    await putConfig({ gpu_live_render_enabled: false });
    const doc = await db
      .collection("app_settings")
      .findOne({ _id: "render" as never });
    expect(doc).not.toBeNull();
    expect(
      (doc as { config: { gpu_live_render_enabled: boolean } }).config
        .gpu_live_render_enabled,
    ).toBe(false);
  });
});
