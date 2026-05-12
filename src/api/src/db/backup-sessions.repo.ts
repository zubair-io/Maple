/**
 * backup_sessions repository.
 *
 * One row per (library_id, device_id) summarising cumulative PhotoKit backup
 * progress from that device. Updated by the backup-ingest endpoint after every
 * successful or failed upload so the device can render "X% done from this
 * device" without scanning the assets collection.
 *
 * Spec: docs/superpowers/specs/2026-05-09-photokit-backup-design.md §19.
 */

import type { ObjectId } from "mongodb";
import { backupSessionsCollection } from "./client.ts";

export const backupSessionsRepo = {
  async upsertProgress(args: {
    libraryId: ObjectId;
    deviceId: string;
    uploadedDelta: number;
    failedDelta: number;
    totalCount?: number;
  }): Promise<void> {
    if (args.uploadedDelta < 0 || args.failedDelta < 0) {
      throw new Error("backupSessionsRepo.upsertProgress: deltas must be >= 0");
    }
    const coll = await backupSessionsCollection();
    const now = new Date();
    await coll.updateOne(
      { library_id: args.libraryId, device_id: args.deviceId },
      {
        $inc: {
          uploaded_count: args.uploadedDelta,
          failed_count: args.failedDelta,
        },
        $set: {
          last_progress_at: now,
          ...(args.totalCount !== undefined ? { total_count: args.totalCount } : {}),
        },
        $setOnInsert: { started_at: now },
      },
      { upsert: true },
    );
  },

  async findOne(args: { libraryId: ObjectId; deviceId: string }) {
    const coll = await backupSessionsCollection();
    return coll.findOne({ library_id: args.libraryId, device_id: args.deviceId });
  },
};
