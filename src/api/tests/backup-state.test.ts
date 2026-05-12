import { describe, test, expect, beforeAll } from "bun:test";
import { ObjectId } from "mongodb";
import { app } from "../src/index.ts";
import { assetsCollection, foldersCollection } from "../src/db/client.ts";

const libId = new ObjectId();
const deviceId = "test-device-state";

beforeAll(async () => {
  await (await foldersCollection()).insertOne({ _id: libId, path: "/tmp/x", label: "x", created_at: new Date(), file_count: 0 } as any);
  const a = await assetsCollection();
  await a.deleteMany({ "phasset_links.device_id": deviceId });
  await a.insertMany([
    {
      folder_id: libId, filename: "a.heic", abs_path: "/tmp/x/a.heic",
      size: 1, mtime: 0, rating: 0, flag: 0, color_label: "",
      indexed_at: "2026-05-11T00:00:00Z",
      maple_id: "hash-a",
      phasset_links: [{ device_id: deviceId, phasset_local_id: "P1", first_seen: new Date("2026-05-10T00:00:00Z") }],
    },
    {
      folder_id: libId, filename: "b.heic", abs_path: "/tmp/x/b.heic",
      size: 1, mtime: 0, rating: 0, flag: 0, color_label: "",
      indexed_at: "2026-05-11T00:00:00Z",
      maple_id: "hash-b",
      phasset_links: [{ device_id: deviceId, phasset_local_id: "P2", first_seen: new Date("2026-05-11T01:00:00Z") }],
    },
  ] as any);
});

describe("GET /api/libraries/:id/backup/state", () => {
  test("returns only assets first-seen since `since` for the given device", async () => {
    const since = "2026-05-10T12:00:00Z";
    const url = `http://localhost/api/libraries/${libId.toHexString()}/backup/state?device_id=${deviceId}&since=${encodeURIComponent(since)}`;
    const res = await app.handle(new Request(url));
    expect(res.status).toBe(200);
    const body = await res.json();
    const ids = body.assets.map((a: any) => a.phasset_local_id).sort();
    expect(ids).toEqual(["P2"]);
    expect(body.assets[0].maple_id).toBe("hash-b");
  });

  test("returns all device assets when `since` is omitted", async () => {
    const url = `http://localhost/api/libraries/${libId.toHexString()}/backup/state?device_id=${deviceId}`;
    const res = await app.handle(new Request(url));
    expect(res.status).toBe(200);
    const body = await res.json();
    const ids = body.assets.map((a: any) => a.phasset_local_id).sort();
    expect(ids).toEqual(["P1", "P2"]);
  });

  test("400 when device_id missing", async () => {
    const url = `http://localhost/api/libraries/${libId.toHexString()}/backup/state`;
    const res = await app.handle(new Request(url));
    expect(res.status).toBe(400);
  });

  test("400 on invalid library id", async () => {
    const res = await app.handle(new Request(`http://localhost/api/libraries/not-an-objectid/backup/state?device_id=${deviceId}`));
    expect(res.status).toBe(400);
  });
});
