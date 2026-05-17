import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { Elysia } from "elysia";
import { ObjectId } from "mongodb";
import { changesRoutes } from "./changes.ts";
import {
  getChangeBus,
  __resetChangeBusForTests,
} from "../runtime/change-bus.ts";
import type { AssetChangeWithId } from "../db/schema.ts";

function evt(cursor: number): AssetChangeWithId {
  return {
    _id: new ObjectId(),
    cursor,
    asset_id: new ObjectId(),
    folder_id: new ObjectId(),
    kind: "update",
    abs_path: `/p/${cursor}.dng`,
    at: new Date(),
  } as AssetChangeWithId;
}

beforeEach(() => {
  __resetChangeBusForTests();
});
afterEach(() => {
  __resetChangeBusForTests();
});

describe("GET /api/changes/subscribe (stale cursor)", () => {
  it("returns 409 when since is below buffer floor", async () => {
    const bus = getChangeBus();
    for (let i = 100; i < 110; i++) bus.publish(evt(i));
    const app = new Elysia().use(changesRoutes);
    const res = await app.handle(
      new Request("http://localhost/api/changes/subscribe?since=1")
    );
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toMatch(/too old/i);
    expect(body.current).toBeGreaterThanOrEqual(109);
  });

  it("returns 400 when since is negative", async () => {
    const app = new Elysia().use(changesRoutes);
    const res = await app.handle(
      new Request("http://localhost/api/changes/subscribe?since=-1")
    );
    expect(res.status).toBe(400);
  });
});
