import { describe, expect, test } from 'bun:test';
import { ObjectId } from 'mongodb';
import { uploadSessionsCollection } from '../db/client.ts';
import { withTestDb } from '../db/test-db.test-helpers.ts';
import { uploadSessions } from './upload-session.ts';

withTestDb(`maple_test_upload_reopen_${process.pid}`);

describe('closed upload-session reset contract (#3707)', () => {
  for (const state of ['completed', 'abandoned'] as const) {
    for (const phassetCloudId of [undefined, 'replacement-cloud-id']) {
      test(`${state}: ${phassetCloudId === undefined ? 'removes' : 'replaces'} prior cloud identity`, async () => {
        const coll = await uploadSessionsCollection();
        const sessionId = new ObjectId();
        const libraryId = new ObjectId();
        const oldDate = new Date('2000-01-01T00:00:00Z');
        await coll.insertOne({
          _id: sessionId,
          library_id: libraryId,
          device_id: 'device',
          phasset_local_id: 'photo',
          state,
          total_bytes: 40,
          received_bytes: 40,
          chunk_size: 10,
          target_rel_path: 'old/photo.dng',
          resolved_rel_path: 'old/resolved.dng',
          maple_id: 'previous-content',
          phasset_cloud_id: 'previous-cloud-id',
          created_at: oldDate,
          updated_at: oldDate,
        });

        const result = await uploadSessions.openOrResume({
          libraryId,
          deviceId: 'device',
          phassetLocalId: 'photo',
          totalBytes: 80,
          chunkSize: 20,
          targetRelPath: 'new/photo.dng',
          ...(phassetCloudId === undefined ? {} : { phassetCloudId }),
        });

        expect(result.reset).toBe(true);
        expect(result.alreadyComplete).toBe(false);
        expect(result.session._id.equals(sessionId)).toBe(true);
        expect(await coll.countDocuments({ library_id: libraryId })).toBe(1);
        const persisted = await coll.findOne({ _id: sessionId });
        expect(persisted).not.toBeNull();
        if (persisted === null) throw new Error('Reset session was not persisted');
        expect(persisted).toEqual(result.session);
        expect(persisted.state).toBe('open');
        expect(persisted.total_bytes).toBe(80);
        expect(persisted.chunk_size).toBe(20);
        expect(persisted.target_rel_path).toBe('new/photo.dng');
        expect(persisted.received_bytes).toBe(0);
        expect(persisted.maple_id).toBeUndefined();
        expect(persisted.resolved_rel_path).toBeUndefined();
        expect(persisted.phasset_cloud_id).toBe(phassetCloudId);
        expect(persisted.created_at.getTime()).toBeGreaterThan(oldDate.getTime());
        expect(persisted.updated_at).toEqual(persisted.created_at);
      });
    }
  }
});
