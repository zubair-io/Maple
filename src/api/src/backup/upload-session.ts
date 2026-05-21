/**
 * upload_sessions repository.
 *
 * One row per in-flight or resumable chunked upload from a device. The resume
 * key is the natural compound key (library_id, device_id, phasset_local_id) —
 * all three are known to the device at enqueue, so the device can resume
 * without remembering an opaque session id. Indexed uniquely in
 * ensureIndexes().
 *
 * Sessions are TTL-eligible — abandoned uploads older than 7d get swept by
 * gcAbandoned() and their state flips to "abandoned". A subsequent retry
 * starts fresh because openOrResume() filters for state "open".
 *
 * `openOrResume` is self-healing on same-key metadata mismatch — when the
 * device retries with a different total_bytes or target_rel_path (e.g. the
 * user edited the photo between attempts), the existing row is reset in
 * place instead of throwing. The unique index spans all states so we can't
 * insert a second row for the same key.
 *
 * Cross-device coordination uses `phasset_cloud_id`: when two devices on the
 * same iCloud library both try to upload the same photo, the second one is
 * told to back off if the first is actively progressing (last chunk
 * received < CROSS_DEVICE_BUSY_WINDOW_MS ago). If the first is stale, it's
 * marked abandoned and the second takes over.
 *
 * Spec: docs/superpowers/specs/2026-05-09-photokit-backup-design.md §16, §20.
 */
import { ObjectId } from "mongodb";
import { uploadSessionsCollection } from "../db/client.ts";
import type { UploadSessionDoc } from "../db/schema.ts";

/** A peer device is considered "actively uploading" if its session has
 * received a chunk within this window. Generous enough that a phone going
 * to sleep mid-upload, or a network blip across several backoff cycles,
 * doesn't get its in-progress upload stolen by a sibling device. The cost
 * of being conservative is that if the peer is truly dead, takeover waits
 * up to this long — acceptable because both devices typically have the
 * same iCloud copy, so deferring rather than racing is the safe default. */
export const CROSS_DEVICE_BUSY_WINDOW_MS = 30 * 60 * 1000;

/** Thrown by openOrResume when another device is actively uploading the same
 * iCloud photo. Routes catch this and translate to HTTP 423. */
export class BusyElsewhereError extends Error {
  readonly retryAfterSeconds: number;
  constructor(retryAfterSeconds: number) {
    super("another device is actively uploading this asset");
    this.name = "BusyElsewhereError";
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export interface OpenOrResumeResult {
  session: UploadSessionDoc;
  /** True when the existing session was reset in place (metadata mismatch
   * self-heal). The route must unlink the stale tmp file so the next chunk
   * append doesn't pick up old bytes. */
  reset: boolean;
  /** True when the existing session was already `state: "completed"` for the
   * same `(total_bytes, target_rel_path)`. The route short-circuits to HTTP
   * 200 with the stored `maple_id` + `target_rel_path` so the client doesn't
   * burn retry slots on an upload that already finished server-side. Triggered
   * when the original chunked upload completed but a downstream step in the
   * device pipeline (sidecar, rendered, live video) failed and re-enqueued
   * the task. */
  alreadyComplete: boolean;
}

export const uploadSessions = {
  async openOrResume(args: {
    libraryId: ObjectId;
    deviceId: string;
    phassetLocalId: string;
    totalBytes: number;
    chunkSize: number;
    targetRelPath: string;
    phassetCloudId?: string;
  }): Promise<OpenOrResumeResult> {
    const coll = await uploadSessionsCollection();

    // Cross-device check: another device on this library actively uploading
    // the same iCloud photo? Only meaningful when both sides have a cloud id.
    //
    // This findOne/throw/insert sequence is NOT atomic. Two devices that fire
    // their first chunk inside the same ~millisecond window can both observe
    // no peer and both proceed. That's deliberate — the final-chunk path
    // (`backup-ingest.ts` post-assembly) dedups by `maple_id`, so the worst
    // case is one device burns redundant bandwidth and its bytes get
    // discarded at the finish line. Adding a unique constraint over
    // `(library_id, phasset_cloud_id)` would prevent the wasted upload but
    // would also serialize legitimate same-cloud-id retries through the
    // unique-key violation path — a worse trade for this workload, where
    // simultaneous-first-chunk collisions are rare.
    if (args.phassetCloudId) {
      // Sort by `updated_at` DESCENDING and inspect the most recently active
      // peer first. The cloud-id index is intentionally non-unique (see the
      // comment block below), so after a simultaneous-first-chunk race there
      // may be multiple "open" peer rows for the same cloud id. A naive
      // `findOne` would return an arbitrary one — and if that happened to be
      // a stale duplicate while a sibling row was still actively progressing,
      // we'd abandon the stale row and let the caller proceed alongside the
      // active peer, defeating the whole 423 coordination. By preferring the
      // most-recently-updated peer:
      //   - If THAT one is active, return 423 (the active peer wins).
      //   - If THAT one is stale, every other peer (older) is stale too, so
      //     we sweep them all to "abandoned" in one pass.
      const peer = await coll.findOne(
        {
          library_id: args.libraryId,
          phasset_cloud_id: args.phassetCloudId,
          state: "open",
          $or: [
            { device_id: { $ne: args.deviceId } },
            { phasset_local_id: { $ne: args.phassetLocalId } },
          ],
        },
        { sort: { updated_at: -1 } },
      );
      if (peer) {
        const ageMs = Date.now() - peer.updated_at.getTime();
        if (ageMs <= CROSS_DEVICE_BUSY_WINDOW_MS) {
          // Peer is actively progressing — tell the caller to back off until
          // the peer either completes or goes stale.
          const retryAfter = Math.ceil(
            (CROSS_DEVICE_BUSY_WINDOW_MS - ageMs) / 1000,
          );
          throw new BusyElsewhereError(retryAfter);
        }
        // The most-recent peer is stale → all peers are stale. Sweep every
        // matching open row to "abandoned" so the merged-timeline GC doesn't
        // keep pointing at sessions that will never complete. The caller's
        // session (created or reused below) wins.
        await coll.updateMany(
          {
            library_id: args.libraryId,
            phasset_cloud_id: args.phassetCloudId,
            state: "open",
            $or: [
              { device_id: { $ne: args.deviceId } },
              { phasset_local_id: { $ne: args.phassetLocalId } },
            ],
          },
          { $set: { state: "abandoned", updated_at: new Date() } },
        );
      }
    }

    // Look up by resume key WITHOUT a state filter. The unique index spans
    // all states (open, abandoned, completed) so we cannot blindly insert
    // a new row when state="open" misses — an abandoned row from a prior
    // cross-device takeover would collide with the index and the route
    // would turn that into the `resumeMismatchNoOffset` failure this PR
    // is meant to eliminate.
    const existing = await coll.findOne({
      library_id: args.libraryId,
      device_id: args.deviceId,
      phasset_local_id: args.phassetLocalId,
    });

    if (existing?.state === "open") {
      const totalChanged = existing.total_bytes !== args.totalBytes;
      const pathChanged = existing.target_rel_path !== args.targetRelPath;
      if (totalChanged || pathChanged) {
        // Self-heal: the device is the source of truth for what it currently
        // holds — reset in place so the next chunk starts at offset 0 with
        // the new metadata. The unique index spans all states, so we update
        // rather than abandon-then-insert.
        const unsetFields: Record<string, ""> = {};
        if (
          args.phassetCloudId === undefined &&
          existing.phasset_cloud_id !== undefined
        ) {
          unsetFields.phasset_cloud_id = "";
        }
        const now = new Date();
        await coll.updateOne(
          { _id: existing._id },
          {
            $set: {
              total_bytes: args.totalBytes,
              target_rel_path: args.targetRelPath,
              chunk_size: args.chunkSize,
              received_bytes: 0,
              updated_at: now,
              ...(args.phassetCloudId !== undefined
                ? { phasset_cloud_id: args.phassetCloudId }
                : {}),
            },
            ...(Object.keys(unsetFields).length > 0
              ? { $unset: unsetFields }
              : {}),
          },
        );
        const refreshed = (await coll.findOne({ _id: existing._id }))!;
        return { session: refreshed, reset: true, alreadyComplete: false };
      }
      // No reset needed. If the caller is now offering a cloud id we didn't
      // have before, enrich the row in place — this is metadata-only and
      // doesn't invalidate progress (e.g. iCloud was enabled mid-upload).
      if (
        args.phassetCloudId !== undefined &&
        existing.phasset_cloud_id === undefined
      ) {
        await coll.updateOne(
          { _id: existing._id },
          {
            $set: {
              phasset_cloud_id: args.phassetCloudId,
              updated_at: new Date(),
            },
          },
        );
        existing.phasset_cloud_id = args.phassetCloudId;
      }
      return { session: existing, reset: false, alreadyComplete: false };
    }

    if (existing?.state === "completed") {
      // The original chunked upload finished — but a downstream step in the
      // device pipeline (sidecar, rendered companion, Live Photo .mov) threw
      // and re-enqueued the task. The client is now retrying the original
      // upload from offset 0; without this branch, `insertOne` below would
      // collide on the unique resume-key index, the route would return 409
      // without an `expected_offset`, and the client would burn retry slots
      // until `.failedRetry`.
      //
      // Same-content retry: tell the route to short-circuit to HTTP 200 with
      // the stored maple_id + target_rel_path. The client treats that as
      // success without re-sending the bytes.
      //
      // Different content (total_bytes or target_rel_path drift): treat as a
      // genuine new upload for the same (deviceId, phid) — reopen in place
      // exactly like the abandoned-state path. This covers the rare case of
      // the user editing an asset after the previous version was uploaded.
      const totalChanged = existing.total_bytes !== args.totalBytes;
      const pathChanged = existing.target_rel_path !== args.targetRelPath;
      // `maple_id` is typed optional on UploadSessionDoc — `complete()` always
      // sets it under the normal flow, but a corrupt/legacy/migration-inserted
      // row could be `state: "completed"` without one. Short-circuiting in
      // that case would return a 200 body the Swift client can't decode
      // (`maple_id` is required on its response struct), kicking the engine
      // back into the same retry loop this PR is meant to fix. Treat the
      // missing-id case as corrupt and fall through to reopen-in-place so
      // the client re-uploads from offset 0 and we recover a valid maple_id
      // on the next final chunk.
      if (!totalChanged && !pathChanged && existing.maple_id) {
        return { session: existing, reset: false, alreadyComplete: true };
      }
      const unsetFields: Record<string, ""> = { maple_id: "" };
      if (
        args.phassetCloudId === undefined &&
        existing.phasset_cloud_id !== undefined
      ) {
        unsetFields.phasset_cloud_id = "";
      }
      const now = new Date();
      await coll.updateOne(
        { _id: existing._id },
        {
          $set: {
            state: "open",
            total_bytes: args.totalBytes,
            target_rel_path: args.targetRelPath,
            chunk_size: args.chunkSize,
            received_bytes: 0,
            created_at: now,
            updated_at: now,
            ...(args.phassetCloudId !== undefined
              ? { phasset_cloud_id: args.phassetCloudId }
              : {}),
          },
          $unset: unsetFields,
        },
      );
      const refreshed = (await coll.findOne({ _id: existing._id }))!;
      return { session: refreshed, reset: true, alreadyComplete: false };
    }

    if (existing?.state === "abandoned") {
      // The row was abandoned by a cross-device takeover or by gcAbandoned().
      // Reopen in place — inserting a new row would collide with the unique
      // resume-key index. The route treats reset:true as "clear stale tmp
      // bytes" so the next chunk starts at offset 0 cleanly.
      const unsetFields: Record<string, ""> = { maple_id: "" };
      if (
        args.phassetCloudId === undefined &&
        existing.phasset_cloud_id !== undefined
      ) {
        unsetFields.phasset_cloud_id = "";
      }
      const now = new Date();
      await coll.updateOne(
        { _id: existing._id },
        {
          $set: {
            state: "open",
            total_bytes: args.totalBytes,
            target_rel_path: args.targetRelPath,
            chunk_size: args.chunkSize,
            received_bytes: 0,
            created_at: now,
            updated_at: now,
            ...(args.phassetCloudId !== undefined
              ? { phasset_cloud_id: args.phassetCloudId }
              : {}),
          },
          $unset: unsetFields,
        },
      );
      const refreshed = (await coll.findOne({ _id: existing._id }))!;
      return { session: refreshed, reset: true, alreadyComplete: false };
    }

    const now = new Date();
    const doc: UploadSessionDoc = {
      _id: new ObjectId(),
      library_id: args.libraryId,
      device_id: args.deviceId,
      phasset_local_id: args.phassetLocalId,
      target_rel_path: args.targetRelPath,
      total_bytes: args.totalBytes,
      received_bytes: 0,
      chunk_size: args.chunkSize,
      state: "open",
      created_at: now,
      updated_at: now,
      ...(args.phassetCloudId ? { phasset_cloud_id: args.phassetCloudId } : {}),
    };
    await coll.insertOne(doc);
    return { session: doc, reset: false, alreadyComplete: false };
  },

  async recordChunk(args: { sessionId: ObjectId; bytesReceived: number }): Promise<void> {
    if (args.bytesReceived < 0) {
      throw new Error("uploadSessions.recordChunk: bytesReceived must be >= 0");
    }
    const coll = await uploadSessionsCollection();
    await coll.updateOne(
      { _id: args.sessionId },
      { $inc: { received_bytes: args.bytesReceived }, $set: { updated_at: new Date() } },
    );
  },

  async complete(args: { sessionId: ObjectId; mapleId: string }): Promise<void> {
    const coll = await uploadSessionsCollection();
    await coll.updateOne(
      { _id: args.sessionId },
      { $set: { state: "completed", maple_id: args.mapleId, updated_at: new Date() } },
    );
  },

  async findById(id: ObjectId): Promise<UploadSessionDoc | null> {
    const coll = await uploadSessionsCollection();
    return coll.findOne({ _id: id });
  },

  /** Reset received_bytes to 0 when disk and DB are out of sync (e.g. tmp file
   * was deleted). The client must restart from offset 0. */
  async resetForRestart(sessionId: ObjectId): Promise<void> {
    const coll = await uploadSessionsCollection();
    await coll.updateOne(
      { _id: sessionId },
      { $set: { received_bytes: 0, updated_at: new Date() } },
    );
  },

  /** Mark "open" sessions whose updated_at is older than `cutoff` as abandoned.
   * Returns the number of rows updated. Called by a periodic job / startup. */
  async gcAbandoned(cutoff: Date): Promise<number> {
    const coll = await uploadSessionsCollection();
    const r = await coll.updateMany(
      { state: "open", updated_at: { $lt: cutoff } },
      { $set: { state: "abandoned" } },
    );
    return r.modifiedCount;
  },
};
