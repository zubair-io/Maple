import { describe, test, expect, beforeAll } from "bun:test";
import { ObjectId } from "mongodb";
import { backupSessionsRepo } from "./backup-sessions.repo.ts";
import { backupSessionsCollection } from "./client.ts";

describe("backupSessionsRepo", () => {
  const libraryId = new ObjectId();
  const deviceId = "test-device-uuid";

  beforeAll(async () => {
    const coll = await backupSessionsCollection();
    await coll.deleteMany({ library_id: libraryId, device_id: deviceId });
  });

  test("upsertProgress creates a row on first call and accumulates after", async () => {
    await backupSessionsRepo.upsertProgress({
      libraryId,
      deviceId,
      uploadedDelta: 1,
      failedDelta: 0,
      totalCount: 100,
    });
    await backupSessionsRepo.upsertProgress({
      libraryId,
      deviceId,
      uploadedDelta: 2,
      failedDelta: 1,
      totalCount: 100,
    });
    const row = await backupSessionsRepo.findOne({ libraryId, deviceId });
    expect(row?.uploaded_count).toBe(3);
    expect(row?.failed_count).toBe(1);
    expect(row?.total_count).toBe(100);
  });

  test("rejects negative deltas", async () => {
    await expect(
      backupSessionsRepo.upsertProgress({
        libraryId: new ObjectId(),
        deviceId: "neg-test",
        uploadedDelta: -1,
        failedDelta: 0,
      }),
    ).rejects.toThrow(/deltas must be >= 0/);
  });
});
