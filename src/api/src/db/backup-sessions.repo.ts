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
