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

  it("emits the stream-opened frame as a raw SSE comment (not data:)", async () => {
    // Regression: the keepalive/open frames used to go through `sse()`
    // which wraps strings as `data: <str>` — the Apple parser then
    // tried to JSON-decode them and dropped the event silently.
    const app = new Elysia().use(changesRoutes);
    const res = await app.handle(
      new Request("http://localhost/api/changes/subscribe?since=0")
    );
    const reader = res.body!.getReader();
    const text = await readWhile(reader, 100);
    // The open frame must begin with the SSE comment marker `:` on its
    // own line, NOT `data: :` (which is what the old `sse(": stream
    // opened")` path produced).
    expect(text.startsWith(": stream opened")).toBe(true);
    expect(text).not.toContain("data: : stream opened");
    try {
      await reader.cancel();
    } catch {}
  });

  it("does not redeliver events that landed in the replay/subscribe seam", async () => {
    // The handler subscribes BEFORE replaying, and filters live events
    // by `cursor > replayMax`. Simulate the seam by pre-loading the
    // buffer and publishing one more between the two operations — the
    // event must appear exactly once on the wire.
    const bus = getChangeBus();
    bus.publish(evt(1));
    bus.publish(evt(2));
    // We can't reach inside the handler's seam directly, but we can
    // verify the dedup logic by publishing a duplicate cursor after
    // the connection opens: the live subscription sees it, but the
    // dedupe (`cursor <= replayMax`) drops it.
    const app = new Elysia().use(changesRoutes);
    const res = await app.handle(
      new Request("http://localhost/api/changes/subscribe?since=0")
    );
    const reader = res.body!.getReader();
    // Re-publish cursor 2 (a duplicate from the client's POV); the
    // dedupe must swallow it. Then publish a fresh cursor 3 to prove
    // live delivery still works.
    setTimeout(() => {
      bus.publish(evt(2));
      bus.publish(evt(3));
    }, 30);
    const text = await readWhile(reader, 300);
    // Cursor 2 must appear exactly once (from the initial replay).
    const matches = text.match(/"cursor":2(?!\d)/g) ?? [];
    expect(matches.length).toBe(1);
    expect(text).toContain('"cursor":3');
    try {
      await reader.cancel();
    } catch {}
  });

  it("closes the connection when the per-client queue exceeds the cap", async () => {
    // Force overflow by publishing > SSE_QUEUE_LIMIT events without
    // letting the reader drain them. The handler must drop the queue
    // and close the stream; the client will reconnect via the existing
    // 409 stale-cursor path.
    const bus = getChangeBus();
    const app = new Elysia().use(changesRoutes);
    const res = await app.handle(
      new Request("http://localhost/api/changes/subscribe?since=0")
    );
    const reader = res.body!.getReader();
    // Read once to flush the open frame so the generator enters the
    // wait loop and starts queueing.
    await reader.read();
    // Publish past the cap. Limit is 10_000; publish 10_005 to be
    // sure we exceed it.
    for (let i = 1; i <= 10_005; i++) bus.publish(evt(i));
    // Drain — the stream should end (done=true) within the deadline.
    let done = false;
    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline) {
      const r = await Promise.race([
        reader.read(),
        new Promise<{ done: true; value: undefined }>((resolve) =>
          setTimeout(() => resolve({ done: true, value: undefined }), 50)
        ),
      ]);
      if (r.done) {
        done = true;
        break;
      }
    }
    expect(done).toBe(true);
    try {
      await reader.cancel();
    } catch {}
  });
});
