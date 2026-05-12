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
 * Spec: docs/superpowers/specs/2026-05-09-photokit-backup-design.md §16, §20.
 */
import { ObjectId } from "mongodb";
import { uploadSessionsCollection } from "../db/client.ts";
import type { UploadSessionDoc } from "../db/schema.ts";

export const uploadSessions = {
  async openOrResume(args: {
    libraryId: ObjectId;
    deviceId: string;
    phassetLocalId: string;
    totalBytes: number;
    chunkSize: number;
    targetRelPath: string;
  }): Promise<UploadSessionDoc> {
    const coll = await uploadSessionsCollection();
    const existing = await coll.findOne({
      library_id: args.libraryId,
      device_id: args.deviceId,
      phasset_local_id: args.phassetLocalId,
      state: "open",
    });
    if (existing) {
      if (existing.total_bytes !== args.totalBytes) {
        throw new Error("openOrResume: totalBytes mismatch");
      }
      if (existing.target_rel_path !== args.targetRelPath) {
        throw new Error("openOrResume: targetRelPath mismatch");
      }
      return existing;
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
    };
    await coll.insertOne(doc);
    return doc;
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
