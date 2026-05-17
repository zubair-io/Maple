import { describe, expect, it } from "bun:test";
import { ObjectId } from "mongodb";
import { ChangeBus } from "./change-bus.ts";
import type { AssetChangeWithId } from "../db/schema.ts";

function evt(cursor: number): AssetChangeWithId {
  return {
    _id: new ObjectId(),
    cursor,
    asset_id: new ObjectId(),
    folder_id: new ObjectId(),
    kind: "update",
    abs_path: `/srv/photos/${cursor}.dng`,
    at: new Date(),
  } as AssetChangeWithId;
}

describe("ChangeBus", () => {
  it("buffers events up to capacity (oldest dropped first)", () => {
    const bus = new ChangeBus({ capacity: 3 });
    bus.publish(evt(1));
    bus.publish(evt(2));
    bus.publish(evt(3));
    bus.publish(evt(4));
    const all = bus.snapshot();
    expect(all.map((e) => e.cursor)).toEqual([2, 3, 4]);
  });

  it("replays events strictly greater than the requested cursor", () => {
    const bus = new ChangeBus({ capacity: 10 });
    for (let i = 1; i <= 5; i++) bus.publish(evt(i));
    expect(bus.replay({ since: 2 }).map((e) => e.cursor)).toEqual([3, 4, 5]);
    expect(bus.replay({ since: 0 }).map((e) => e.cursor)).toEqual([
      1, 2, 3, 4, 5,
    ]);
    expect(bus.replay({ since: 5 }).map((e) => e.cursor)).toEqual([]);
  });

  it("isCursorReplayable returns false when below the buffer floor", () => {
    const bus = new ChangeBus({ capacity: 3 });
    for (let i = 1; i <= 5; i++) bus.publish(evt(i)); // buffer now holds [3,4,5]
    expect(bus.isCursorReplayable(1)).toBe(false);
    expect(bus.isCursorReplayable(2)).toBe(true); // 2+1 = 3 == floor → replayable
    expect(bus.isCursorReplayable(3)).toBe(true);
    expect(bus.isCursorReplayable(5)).toBe(true);
    expect(bus.isCursorReplayable(99)).toBe(true); // future cursor is fine
  });

  it("notifies subscribers in publish order", () => {
    const bus = new ChangeBus({ capacity: 10 });
    const received: number[] = [];
    const unsub = bus.subscribe((e) => received.push(e.cursor));
    bus.publish(evt(1));
    bus.publish(evt(2));
    bus.publish(evt(3));
    unsub();
    bus.publish(evt(4)); // should not be received post-unsub
    expect(received).toEqual([1, 2, 3]);
  });

  it("isCursorReplayable on empty buffer respects persisted high-watermark", () => {
    const bus = new ChangeBus({ capacity: 10 });
    // No watermark set yet — every since is replayable (fresh server,
    // never had events).
    expect(bus.isCursorReplayable(0)).toBe(true);
    expect(bus.isCursorReplayable(99)).toBe(true);
    // Simulate a restart: the persistent store says cursor 500 was the
    // last allocated. A client with since=200 has missed events; only
    // since >= 500 is honest-empty.
    bus.setPersistedHighWatermark(500);
    expect(bus.isCursorReplayable(200)).toBe(false);
    expect(bus.isCursorReplayable(499)).toBe(false);
    expect(bus.isCursorReplayable(500)).toBe(true);
    expect(bus.isCursorReplayable(600)).toBe(true);
  });

  it("publish keeps the buffer cursor-sorted under out-of-order arrivals", () => {
    const bus = new ChangeBus({ capacity: 10 });
    // Simulate the race in recordAndPublishAssetChange — cursor 1 gets
    // allocated first but its Mongo insert + publish runs after cursor 2.
    bus.publish(evt(2));
    bus.publish(evt(1));
    bus.publish(evt(4));
    bus.publish(evt(3));
    expect(bus.snapshot().map((e) => e.cursor)).toEqual([1, 2, 3, 4]);
    expect(bus.replay({ since: 2 }).map((e) => e.cursor)).toEqual([3, 4]);
    expect(bus.bufferFloor()).toBe(1);
  });

  it("publish is idempotent on cursor — duplicate publishes are dropped", () => {
    const bus = new ChangeBus({ capacity: 10 });
    bus.publish(evt(1));
    bus.publish(evt(1));
    bus.publish(evt(2));
    bus.publish(evt(2));
    expect(bus.snapshot().map((e) => e.cursor)).toEqual([1, 2]);
  });
});
