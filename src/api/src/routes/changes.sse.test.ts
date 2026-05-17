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

/**
 * Read from the response stream for `deadlineMs`, accumulating decoded
 * text. Stops on stream end or deadline; callers should cancel the
 * underlying reader afterwards.
 */
async function readWhile(
  reader: ReadableStreamDefaultReader<unknown>,
  deadlineMs: number
): Promise<string> {
  let out = "";
  const decoder = new TextDecoder();
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    const timeoutPromise: Promise<
      ReadableStreamReadResult<unknown> | "TIMEOUT"
    > = new Promise((resolve) =>
      setTimeout(() => resolve("TIMEOUT"), remaining)
    );
    const result = await Promise.race([reader.read(), timeoutPromise]);
    if (result === "TIMEOUT") break;
    if (result.done) break;
    const v = result.value;
    if (typeof v === "string") {
      out += v;
    } else if (v instanceof Uint8Array) {
      out += decoder.decode(v, { stream: true });
    } else if (v != null) {
      out += String(v);
    }
  }
  return out;
}

describe("GET /api/changes/subscribe (SSE)", () => {
  it("replays buffered events on connect", async () => {
    const bus = getChangeBus();
    bus.publish(evt(1));
    bus.publish(evt(2));
    bus.publish(evt(3));
    const app = new Elysia().use(changesRoutes);
    const res = await app.handle(
      new Request("http://localhost/api/changes/subscribe?since=0")
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/event-stream/);
    const reader = res.body!.getReader();
    const text = await readWhile(reader, 250);
    expect(text).toContain('"cursor":1');
    expect(text).toContain('"cursor":2');
    expect(text).toContain('"cursor":3');
    try {
      await reader.cancel();
    } catch {}
  });

  it("streams events published after connect", async () => {
    const bus = getChangeBus();
    const app = new Elysia().use(changesRoutes);
    const res = await app.handle(
      new Request("http://localhost/api/changes/subscribe?since=0")
    );
    const reader = res.body!.getReader();
    setTimeout(() => bus.publish(evt(42)), 30);
    const text = await readWhile(reader, 300);
    expect(text).toContain('"cursor":42');
    try {
      await reader.cancel();
    } catch {}
  });
});
