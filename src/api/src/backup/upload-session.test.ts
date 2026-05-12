import { describe, test, expect, beforeEach } from "bun:test";
import { ObjectId } from "mongodb";
import { uploadSessions } from "./upload-session.ts";
import { uploadSessionsCollection } from "../db/client.ts";

describe("uploadSessions", () => {
  const libraryId = new ObjectId();
  const deviceId = "dev-1";
  const phid = "ABC/L0/001";

  beforeEach(async () => {
    const c = await uploadSessionsCollection();
    await c.deleteMany({ library_id: libraryId, device_id: deviceId });
  });

  test("openOrResume creates a fresh session when none exists", async () => {
    const s = await uploadSessions.openOrResume({
      libraryId,
      deviceId,
      phassetLocalId: phid,
      totalBytes: 1024,
      chunkSize: 256,
      targetRelPath: "2024/Tokyo/03-15/IMG.heic",
    });
    expect(s.received_bytes).toBe(0);
    expect(s.state).toBe("open");
  });

  test("openOrResume returns the existing open session", async () => {
    const a = await uploadSessions.openOrResume({
      libraryId,
      deviceId,
      phassetLocalId: phid,
      totalBytes: 1024,
      chunkSize: 256,
      targetRelPath: "2024/Tokyo/03-15/IMG.heic",
    });
    await uploadSessions.recordChunk({ sessionId: a._id, bytesReceived: 256 });
    const b = await uploadSessions.openOrResume({
      libraryId,
      deviceId,
      phassetLocalId: phid,
      totalBytes: 1024,
      chunkSize: 256,
      targetRelPath: "2024/Tokyo/03-15/IMG.heic",
    });
    expect(b._id.equals(a._id)).toBe(true);
    expect(b.received_bytes).toBe(256);
  });

  test("complete marks the session done and stores maple_id", async () => {
    const s = await uploadSessions.openOrResume({
      libraryId,
      deviceId,
      phassetLocalId: phid,
      totalBytes: 256,
      chunkSize: 256,
      targetRelPath: "2024/Tokyo/03-15/IMG.heic",
    });
    await uploadSessions.recordChunk({ sessionId: s._id, bytesReceived: 256 });
    await uploadSessions.complete({ sessionId: s._id, mapleId: "abc123" });
    const final = await uploadSessions.findById(s._id);
    expect(final?.state).toBe("completed");
    expect(final?.maple_id).toBe("abc123");
  });

  test("gcAbandoned marks old open sessions as abandoned", async () => {
    const c = await uploadSessionsCollection();
    const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    await c.insertOne({
      _id: new ObjectId(),
      library_id: libraryId,
      device_id: deviceId,
      phasset_local_id: phid,
      target_rel_path: "x",
      total_bytes: 100,
      received_bytes: 0,
      chunk_size: 100,
      state: "open",
      created_at: old,
      updated_at: old,
    } as any);
    const swept = await uploadSessions.gcAbandoned(new Date(Date.now() - 7 * 24 * 60 * 60 * 1000));
    expect(swept).toBeGreaterThanOrEqual(1);
  });
});
