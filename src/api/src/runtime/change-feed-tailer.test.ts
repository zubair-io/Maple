import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import { ObjectId, type Db } from "mongodb";
import { ChangeFeedTailer } from "./change-feed-tailer.ts";
import {
  getChangeBus,
  __resetChangeBusForTests,
} from "./change-bus.ts";
import { recordAssetChange } from "../db/changes.repo.ts";
import { getDb, isDbConnected } from "../db/client.ts";
import type { AssetChangeWithId } from "../db/schema.ts";

let db: Db | null = null;
let mongoReachable = false;

beforeEach(async () => {
  try {
    db = await getDb();
    mongoReachable = isDbConnected();
  } catch {
    mongoReachable = false;
    return;
  }
  if (!mongoReachable || !db) return;
  await db.collection("asset_changes").deleteMany({});
  await db.collection("server_state").deleteMany({});
  __resetChangeBusForTests();
});

afterEach(() => {
  __resetChangeBusForTests();
});

afterAll(async () => {
  if (db) {
    await db.collection("asset_changes").deleteMany({});
    await db.collection("server_state").deleteMany({});
  }
});

describe("ChangeFeedTailer", () => {
  it("republishes Mongo rows to the in-process bus on tick", async () => {
    if (!mongoReachable || !db) return;
    const tailer = new ChangeFeedTailer({ intervalMs: 10_000 });
    await tailer.start();
    // After start, localMax == highestCursor (0). Insert a row directly
    // via the repo (simulates a worker in another process).
    await recordAssetChange(db, {
      kind: "create",
      asset_id: new ObjectId(),
      folder_id: new ObjectId(),
      abs_path: "/srv/photos/x.dng",
    });
    const got = await tailer.tickOnce();
    expect(got).toBe(1);
    const snapshot = getChangeBus().snapshot();
    expect(snapshot.length).toBe(1);
    expect(snapshot[0]!.kind).toBe("create");
    tailer.stop();
  });

  it("does not re-publish rows already in the bus (idempotent)", async () => {
    if (!mongoReachable || !db) return;
    const tailer = new ChangeFeedTailer({ intervalMs: 10_000 });
    await tailer.start();
    const cursor = await recordAssetChange(db, {
      kind: "update",
      asset_id: new ObjectId(),
      folder_id: new ObjectId(),
      abs_path: "/srv/photos/y.dng",
    });
    // Simulate an in-process publish from the same API process — this
    // is what `recordAndPublishAssetChange` does after the repo write.
    const bus = getChangeBus();
    bus.publish({
      _id: new ObjectId(),
      cursor,
      asset_id: null,
      folder_id: null,
      kind: "update",
      abs_path: "/srv/photos/y.dng",
      at: new Date(),
    } as AssetChangeWithId);
    expect(bus.snapshot().length).toBe(1);
    // Now tail — should not double-publish.
    await tailer.tickOnce();
    expect(bus.snapshot().length).toBe(1);
    tailer.stop();
  });

  it("advances persisted high-watermark so post-restart 409 fires correctly", async () => {
    if (!mongoReachable || !db) return;
    for (let i = 0; i < 3; i++) {
      await recordAssetChange(db, {
        kind: "create",
        asset_id: new ObjectId(),
        folder_id: new ObjectId(),
        abs_path: `/srv/photos/${i}.dng`,
      });
    }
    // Reset bus to simulate a fresh API process boot AFTER rows existed.
    __resetChangeBusForTests();
    const tailer = new ChangeFeedTailer({ intervalMs: 10_000 });
    await tailer.start();
    // After start, the bus's high-watermark must reflect the existing
    // rows even before any tickOnce.
    const bus = getChangeBus();
    expect(bus.getPersistedHighWatermark()).toBeGreaterThanOrEqual(3);
    // A client reconnecting with since=0 (predates the restart) must
    // be told 409.
    expect(bus.isCursorReplayable(0)).toBe(false);
    tailer.stop();
  });
});
