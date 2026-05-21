import { describe, test, expect, beforeEach } from "bun:test";
import { ObjectId } from "mongodb";
import {
  uploadSessions,
  BusyElsewhereError,
  CROSS_DEVICE_BUSY_WINDOW_MS,
} from "./upload-session.ts";
import { uploadSessionsCollection } from "../db/client.ts";

describe("uploadSessions", () => {
  const libraryId = new ObjectId();
  const deviceId = "dev-1";
  const phid = "ABC/L0/001";

  beforeEach(async () => {
    const c = await uploadSessionsCollection();
    await c.deleteMany({ library_id: libraryId });
  });

  test("openOrResume creates a fresh session when none exists", async () => {
    const { session, reset } = await uploadSessions.openOrResume({
      libraryId,
      deviceId,
      phassetLocalId: phid,
      totalBytes: 1024,
      chunkSize: 256,
      targetRelPath: "2024/Tokyo/03-15/IMG.heic",
    });
    expect(session.received_bytes).toBe(0);
    expect(session.state).toBe("open");
    expect(reset).toBe(false);
  });

  test("openOrResume returns the existing open session", async () => {
    const { session: a } = await uploadSessions.openOrResume({
      libraryId,
      deviceId,
      phassetLocalId: phid,
      totalBytes: 1024,
      chunkSize: 256,
      targetRelPath: "2024/Tokyo/03-15/IMG.heic",
    });
    await uploadSessions.recordChunk({ sessionId: a._id, bytesReceived: 256 });
    const { session: b, reset } = await uploadSessions.openOrResume({
      libraryId,
      deviceId,
      phassetLocalId: phid,
      totalBytes: 1024,
      chunkSize: 256,
      targetRelPath: "2024/Tokyo/03-15/IMG.heic",
    });
    expect(b._id.equals(a._id)).toBe(true);
    expect(b.received_bytes).toBe(256);
    expect(reset).toBe(false);
  });

  test("openOrResume short-circuits same-content retry of a completed session", async () => {
    // Original ingest succeeded; session is in state "completed". Then a
    // downstream step (sidecar / rendered / live) failed and the device is
    // retrying the original upload — same total_bytes, same target path.
    const { session: a } = await uploadSessions.openOrResume({
      libraryId,
      deviceId,
      phassetLocalId: "completed-retry",
      totalBytes: 1024,
      chunkSize: 256,
      targetRelPath: "2024/Tokyo/IMG.heic",
    });
    await uploadSessions.recordChunk({ sessionId: a._id, bytesReceived: 1024 });
    await uploadSessions.complete({ sessionId: a._id, mapleId: "maple-abc" });

    const r = await uploadSessions.openOrResume({
      libraryId,
      deviceId,
      phassetLocalId: "completed-retry",
      totalBytes: 1024,
      chunkSize: 256,
      targetRelPath: "2024/Tokyo/IMG.heic",
    });
    expect(r.alreadyComplete).toBe(true);
    expect(r.reset).toBe(false);
    expect(r.session._id.equals(a._id)).toBe(true);
    expect(r.session.maple_id).toBe("maple-abc");
    expect(r.session.target_rel_path).toBe("2024/Tokyo/IMG.heic");
    expect(r.session.state).toBe("completed");
  });

  test("openOrResume reopens a completed session missing maple_id (corrupt row)", async () => {
    // `maple_id` is typed optional on UploadSessionDoc. complete() always
    // sets it under the normal flow, but a legacy/migration-inserted row
    // could be `state: "completed"` without one. Short-circuiting then would
    // return a 200 body the Swift client can't decode (maple_id is required
    // on its response struct). Verify we treat the missing-id case as
    // corrupt and reopen-in-place instead.
    const c = await uploadSessionsCollection();
    const corruptId = new ObjectId();
    await c.insertOne({
      _id: corruptId,
      library_id: libraryId,
      device_id: deviceId,
      phasset_local_id: "corrupt-completed",
      target_rel_path: "2024/Tokyo/IMG.heic",
      total_bytes: 1024,
      received_bytes: 1024,
      chunk_size: 256,
      state: "completed",
      created_at: new Date(),
      updated_at: new Date(),
      // intentionally no maple_id
    } as any);

    const r = await uploadSessions.openOrResume({
      libraryId,
      deviceId,
      phassetLocalId: "corrupt-completed",
      totalBytes: 1024,
      chunkSize: 256,
      targetRelPath: "2024/Tokyo/IMG.heic",
    });
    expect(r.alreadyComplete).toBe(false);
    expect(r.reset).toBe(true);
    expect(r.session._id.equals(corruptId)).toBe(true);
    expect(r.session.state).toBe("open");
    expect(r.session.received_bytes).toBe(0);
  });

  test("openOrResume reopens a completed session in place when total_bytes changes", async () => {
    // User edited the asset between attempts; total_bytes now differs from
    // the original completed upload. Reuse the row (unique resume-key index)
    // and treat as a fresh upload — same behaviour as the abandoned-state
    // reopen path. alreadyComplete must NOT be set; the client needs to send
    // the new bytes.
    const { session: a } = await uploadSessions.openOrResume({
      libraryId,
      deviceId,
      phassetLocalId: "completed-edit",
      totalBytes: 1024,
      chunkSize: 256,
      targetRelPath: "2024/Tokyo/IMG.heic",
    });
    await uploadSessions.complete({ sessionId: a._id, mapleId: "maple-old" });

    const r = await uploadSessions.openOrResume({
      libraryId,
      deviceId,
      phassetLocalId: "completed-edit",
      totalBytes: 2048, // edited — different size
      chunkSize: 256,
      targetRelPath: "2024/Tokyo/IMG.heic",
    });
    expect(r.alreadyComplete).toBe(false);
    expect(r.reset).toBe(true);
    expect(r.session._id.equals(a._id)).toBe(true);
    expect(r.session.state).toBe("open");
    expect(r.session.total_bytes).toBe(2048);
    expect(r.session.received_bytes).toBe(0);
    expect(r.session.maple_id).toBeUndefined();
  });

  test("complete marks the session done and stores maple_id", async () => {
    const { session } = await uploadSessions.openOrResume({
      libraryId,
      deviceId,
      phassetLocalId: phid,
      totalBytes: 256,
      chunkSize: 256,
      targetRelPath: "2024/Tokyo/03-15/IMG.heic",
    });
    await uploadSessions.recordChunk({ sessionId: session._id, bytesReceived: 256 });
    await uploadSessions.complete({ sessionId: session._id, mapleId: "abc123" });
    const final = await uploadSessions.findById(session._id);
    expect(final?.state).toBe("completed");
    expect(final?.maple_id).toBe("abc123");
  });

  test("openOrResume self-heals on totalBytes mismatch (reset in place)", async () => {
    const { session: a } = await uploadSessions.openOrResume({
      libraryId,
      deviceId,
      phassetLocalId: "mismatch-test",
      totalBytes: 1024,
      chunkSize: 256,
      targetRelPath: "2024/03/15/IMG.heic",
    });
    await uploadSessions.recordChunk({ sessionId: a._id, bytesReceived: 768 });

    const { session: b, reset } = await uploadSessions.openOrResume({
      libraryId,
      deviceId,
      phassetLocalId: "mismatch-test",
      totalBytes: 2048, // different from original
      chunkSize: 256,
      targetRelPath: "2024/03/15/IMG.heic",
    });
    expect(reset).toBe(true);
    expect(b._id.equals(a._id)).toBe(true); // same row, updated in place
    expect(b.total_bytes).toBe(2048);
    expect(b.received_bytes).toBe(0);
    expect(b.state).toBe("open");
  });

  test("openOrResume self-heals on targetRelPath mismatch (reset in place)", async () => {
    const { session: a } = await uploadSessions.openOrResume({
      libraryId,
      deviceId,
      phassetLocalId: "mismatch-path-test",
      totalBytes: 512,
      chunkSize: 128,
      targetRelPath: "2024/03/15/IMG_original.heic",
    });
    await uploadSessions.recordChunk({ sessionId: a._id, bytesReceived: 256 });

    const { session: b, reset } = await uploadSessions.openOrResume({
      libraryId,
      deviceId,
      phassetLocalId: "mismatch-path-test",
      totalBytes: 512,
      chunkSize: 128,
      targetRelPath: "2024/04/01/IMG_renamed.heic", // capture date drifted
    });
    expect(reset).toBe(true);
    expect(b._id.equals(a._id)).toBe(true);
    expect(b.target_rel_path).toBe("2024/04/01/IMG_renamed.heic");
    expect(b.received_bytes).toBe(0);
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

  describe("cross-device coordination via phasset_cloud_id", () => {
    const cloudId = "icloud-PHOTO-XYZ";

    test("throws BusyElsewhereError when another device is actively uploading", async () => {
      // Phone is mid-upload — fresh session.
      await uploadSessions.openOrResume({
        libraryId,
        deviceId: "phone",
        phassetLocalId: "phone-local-001",
        totalBytes: 4_000_000,
        chunkSize: 1_000_000,
        targetRelPath: "2024/Paris/IMG.heic",
        phassetCloudId: cloudId,
      });

      // Desktop tries the same photo concurrently — should be told to back off.
      let err: unknown;
      try {
        await uploadSessions.openOrResume({
          libraryId,
          deviceId: "desktop",
          phassetLocalId: "desktop-local-999",
          totalBytes: 4_000_000,
          chunkSize: 1_000_000,
          targetRelPath: "2024/Paris/IMG.heic",
          phassetCloudId: cloudId,
        });
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(BusyElsewhereError);
      const busy = err as BusyElsewhereError;
      expect(busy.retryAfterSeconds).toBeGreaterThan(0);
      expect(busy.retryAfterSeconds).toBeLessThanOrEqual(
        Math.ceil(CROSS_DEVICE_BUSY_WINDOW_MS / 1000),
      );
    });

    test("prefers freshest peer over stale duplicate when both exist for same cloud_id", async () => {
      // Simulate the post-race state where the non-atomic cross-device guard
      // let two peer rows for the same cloud_id slip through (one ended up
      // stale, one stayed active). Before the sort fix, findOne could return
      // either one — and if it picked the stale row, openOrResume would
      // abandon it and let the caller proceed alongside the still-active
      // sibling, defeating 423 coordination.
      const c = await uploadSessionsCollection();
      const sharedCloudId = "icloud-DUPLICATE-PEERS";
      const stale = new Date(Date.now() - CROSS_DEVICE_BUSY_WINDOW_MS - 60_000);
      const fresh = new Date(Date.now() - 30_000); // < busy window
      await c.insertMany([
        {
          _id: new ObjectId(),
          library_id: libraryId,
          device_id: "phone-stale-dup",
          phasset_local_id: "phone-local-stale-dup",
          target_rel_path: "2024/Paris/IMG_DUP.heic",
          total_bytes: 4_000_000,
          received_bytes: 1_000_000,
          chunk_size: 1_000_000,
          state: "open",
          created_at: stale,
          updated_at: stale,
          phasset_cloud_id: sharedCloudId,
        },
        {
          _id: new ObjectId(),
          library_id: libraryId,
          device_id: "tablet-fresh-dup",
          phasset_local_id: "tablet-local-fresh-dup",
          target_rel_path: "2024/Paris/IMG_DUP.heic",
          total_bytes: 4_000_000,
          received_bytes: 2_000_000,
          chunk_size: 1_000_000,
          state: "open",
          created_at: fresh,
          updated_at: fresh,
          phasset_cloud_id: sharedCloudId,
        },
      ] as any);

      // Desktop tries the same cloud_id — must see the FRESH peer and 423,
      // not the stale one.
      let err: unknown;
      try {
        await uploadSessions.openOrResume({
          libraryId,
          deviceId: "desktop-arbiter",
          phassetLocalId: "desktop-local-arbiter",
          totalBytes: 4_000_000,
          chunkSize: 1_000_000,
          targetRelPath: "2024/Paris/IMG_DUP.heic",
          phassetCloudId: sharedCloudId,
        });
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(BusyElsewhereError);
      // Stale peer must NOT have been abandoned — that would have signaled
      // "all clear" and let a third caller proceed concurrently with the
      // still-active fresh peer.
      const stillOpenStale = await c.findOne({
        library_id: libraryId,
        device_id: "phone-stale-dup",
        state: "open",
      });
      expect(stillOpenStale).not.toBeNull();
    });

    test("abandons stale peer session and proceeds", async () => {
      const c = await uploadSessionsCollection();
      const staleTime = new Date(
        Date.now() - CROSS_DEVICE_BUSY_WINDOW_MS - 60_000,
      );
      // Manually insert a stale phone session (older than the busy window).
      const stalePhoneId = new ObjectId();
      await c.insertOne({
        _id: stalePhoneId,
        library_id: libraryId,
        device_id: "phone-stale",
        phasset_local_id: "phone-local-002",
        target_rel_path: "2024/Paris/IMG.heic",
        total_bytes: 4_000_000,
        received_bytes: 1_000_000,
        chunk_size: 1_000_000,
        state: "open",
        created_at: staleTime,
        updated_at: staleTime,
        phasset_cloud_id: cloudId,
      } as any);

      // Desktop comes along after the peer went silent.
      const { session, reset } = await uploadSessions.openOrResume({
        libraryId,
        deviceId: "desktop",
        phassetLocalId: "desktop-local-998",
        totalBytes: 4_000_000,
        chunkSize: 1_000_000,
        targetRelPath: "2024/Paris/IMG.heic",
        phassetCloudId: cloudId,
      });
      expect(reset).toBe(false);
      expect(session.device_id).toBe("desktop");
      expect(session.state).toBe("open");

      // Stale peer is now marked abandoned.
      const peer = await c.findOne({ _id: stalePhoneId });
      expect(peer?.state).toBe("abandoned");
    });

    test("stale device returning after cross-device takeover reopens its abandoned row (no unique-key collision)", async () => {
      const c = await uploadSessionsCollection();
      // Phone established a session, then went silent and got abandoned by
      // a cross-device takeover. Simulate that resting state directly.
      const phoneId = new ObjectId();
      const ago = new Date(Date.now() - 60_000);
      await c.insertOne({
        _id: phoneId,
        library_id: libraryId,
        device_id: "phone-stale-return",
        phasset_local_id: "phone-local-stale-return",
        target_rel_path: "2024/Paris/IMG_STALE.heic",
        total_bytes: 4_096,
        received_bytes: 2_048,
        chunk_size: 1_024,
        state: "abandoned",
        created_at: ago,
        updated_at: ago,
        phasset_cloud_id: "icloud-STALE-RETURN",
      } as any);

      // Phone wakes up and tries to resume. Before the fix this would hit a
      // unique-key collision because the abandoned row still occupies the
      // (library_id, device_id, phasset_local_id) slot.
      const { session, reset } = await uploadSessions.openOrResume({
        libraryId,
        deviceId: "phone-stale-return",
        phassetLocalId: "phone-local-stale-return",
        totalBytes: 4_096,
        chunkSize: 1_024,
        targetRelPath: "2024/Paris/IMG_STALE.heic",
        phassetCloudId: "icloud-STALE-RETURN",
      });
      // Reopened in place on the same _id.
      expect(session._id.equals(phoneId)).toBe(true);
      expect(session.state).toBe("open");
      expect(session.received_bytes).toBe(0);
      // Route uses reset to clear any stale tmp bytes.
      expect(reset).toBe(true);
    });

    test("does not flag the caller's own session as a peer conflict", async () => {
      // First call from desktop establishes its own session.
      const { session: first } = await uploadSessions.openOrResume({
        libraryId,
        deviceId: "desktop",
        phassetLocalId: "desktop-local-777",
        totalBytes: 1024,
        chunkSize: 256,
        targetRelPath: "2024/Paris/IMG.heic",
        phassetCloudId: cloudId,
      });
      // Same caller resumes — must NOT see its own row as a peer.
      const { session: second } = await uploadSessions.openOrResume({
        libraryId,
        deviceId: "desktop",
        phassetLocalId: "desktop-local-777",
        totalBytes: 1024,
        chunkSize: 256,
        targetRelPath: "2024/Paris/IMG.heic",
        phassetCloudId: cloudId,
      });
      expect(second._id.equals(first._id)).toBe(true);
    });

    test("enriches an existing session with cloud id without resetting progress", async () => {
      // Initial chunk arrived before iCloud was enabled — no cloud id.
      const { session: a } = await uploadSessions.openOrResume({
        libraryId,
        deviceId: "phone-enrich",
        phassetLocalId: "phone-local-enrich",
        totalBytes: 4096,
        chunkSize: 1024,
        targetRelPath: "2024/Paris/IMG_ENRICH.heic",
      });
      await uploadSessions.recordChunk({
        sessionId: a._id,
        bytesReceived: 2048,
      });
      expect(a.phasset_cloud_id).toBeUndefined();

      // Next chunk arrives after iCloud was enabled — cloud id appears.
      const { session: b, reset } = await uploadSessions.openOrResume({
        libraryId,
        deviceId: "phone-enrich",
        phassetLocalId: "phone-local-enrich",
        totalBytes: 4096,
        chunkSize: 1024,
        targetRelPath: "2024/Paris/IMG_ENRICH.heic",
        phassetCloudId: "icloud-LATE-ENRICH",
      });
      expect(reset).toBe(false);
      expect(b._id.equals(a._id)).toBe(true);
      expect(b.received_bytes).toBe(2048); // progress preserved
      expect(b.phasset_cloud_id).toBe("icloud-LATE-ENRICH");
    });

    test("skips cross-device check when phasset_cloud_id is absent", async () => {
      // Phone session WITHOUT cloud id — local-only photo.
      await uploadSessions.openOrResume({
        libraryId,
        deviceId: "phone",
        phassetLocalId: "phone-local-noicloud",
        totalBytes: 1024,
        chunkSize: 256,
        targetRelPath: "2024/Paris/IMG.heic",
        // no phassetCloudId
      });
      // Desktop with cloud id, same path — not blocked because peer has no cloud id.
      const { session } = await uploadSessions.openOrResume({
        libraryId,
        deviceId: "desktop",
        phassetLocalId: "desktop-local-noicloud",
        totalBytes: 1024,
        chunkSize: 256,
        targetRelPath: "2024/Paris/IMG.heic",
        phassetCloudId: cloudId,
      });
      expect(session.state).toBe("open");
    });
  });
});
