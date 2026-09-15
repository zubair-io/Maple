import { test, expect } from 'bun:test';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { MongoClient, type Document } from 'mongodb';
import { auditMapleIds, ID_COLLECTIONS } from './maple-ids.ts';

test('read-only audit separates invalid, legacy, case, collisions and unresolved references', async () => {
  const server = await MongoMemoryServer.create();
  const client = new MongoClient(server.getUri());
  try {
    await client.connect();
    const db = client.db('id_audit_test');
    const canonical = '01' + 'ab'.repeat(15);
    await db
      .collection('assets')
      .insertMany([
        { maple_id: canonical },
        { maple_id: canonical.toUpperCase() },
        { maple_id: '01' + '0g'.repeat(15) },
        {},
        { maple_id: null },
        { maple_id: '' },
        { maple_id: 123 },
        { maple_id: 'ff' + '12'.repeat(15) },
      ]);
    await db
      .collection('upload_sessions')
      .insertMany([
        { maple_id: canonical },
        { maple_id: '02' + '12'.repeat(15) },
        { status: 'uploading' },
      ]);
    await db.collection('meilisearch_backfill_failures').insertOne({ maple_id: 'bad-id' });
    const before = await Promise.all(
      ID_COLLECTIONS.map((name) => db.collection(name).find().toArray()),
    );
    const findings: Document[] = [];
    const summary = await auditMapleIds(db, (f) => {
      findings.push(f);
    });
    expect(summary.counts.assets).toEqual({
      canonical: 2,
      'noncanonical-case': 1,
      malformed: 2,
      'missing-legacy': 3,
    });
    expect(summary.collisionGroups).toBe(1);
    expect(findings.filter((f) => f.type === 'collision-owner')).toHaveLength(2);
    expect(findings.filter((f) => f.type === 'unresolved-reference')).toHaveLength(1);
    expect(summary.identityVerified).toBe(false);
    expect(await auditMapleIds(db, () => {})).toEqual(summary);
    expect(
      await Promise.all(ID_COLLECTIONS.map((name) => db.collection(name).find().toArray())),
    ).toEqual(before);
  } finally {
    await client.close();
    await server.stop();
  }
}, 30000);
