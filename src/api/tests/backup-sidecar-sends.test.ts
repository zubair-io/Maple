/**
 * A backup send is placed on the edit history by what the device actually sent
 * (#5796): a digest base merges from the sent document even when the server
 * reconciled it into something else (also after the photo moved, and after a
 * publish that failed), a repeated digest names its latest send, a send
 * acknowledged as unchanged stays a base its digest names, and the named
 * snapshots a device publishes into the file are kept, on its first send and
 * on every later one.
 *
 * Real temp library files, real XMP documents and a private SQLite database.
 */
import { describe, test, expect } from 'bun:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { callNative } from 'maple';
import { relocateAsset } from '../src/library/relocate-asset.ts';
import { insertLocation } from '../src/db/sqlite/test-sqlite.test-helpers.ts';
import { xmpSidecarPath } from '../src/fs/xmp.ts';
import {
  history,
  labelOf,
  property,
  sha256,
  useSidecarLibrary,
  xmp,
} from './helpers/backup-sidecar-fixtures.ts';

const lib = useSidecarLibrary();
const { seedUpload, post, onDisk, firstSend } = lib;

async function native(
  method: 'workflowCheckpointXmp' | 'workflowCommitXmp' | 'workflowSnapshotXmp' | 'workflowReadXmp',
  args: [string] | [string, string],
): Promise<string> {
  const result = await callNative(method, args);
  if (!result.ok) throw Error(result.error);
  return result.value;
}

/** `document` as the device publishes it: with its own `papp:Workflow` record. */
async function withDeviceRecord(document: string): Promise<string> {
  const entry = {
    id: '00000000-0000-5000-8000-0000000000aa',
    createdAtMs: 1,
    action: 'adjustment',
    label: 'Device edit',
    parentId: '',
    writer: 'apple',
    adjustmentXmp: await native('workflowCheckpointXmp', [document]),
  };
  return native('workflowCommitXmp', [document, JSON.stringify(entry)]);
}

/** `document` with a named snapshot of its own adjustments, as the device takes one. */
async function withSnapshot(document: string, n: number): Promise<{ xmp: string; id: string }> {
  const id = `00000000-0000-5000-8000-${n.toString(16).padStart(12, '0')}`;
  const snapshot = {
    id,
    name: `Look ${n}`,
    createdAtMs: n,
    adjustmentXmp: await native('workflowCheckpointXmp', [document]),
  };
  return { xmp: await native('workflowSnapshotXmp', [document, JSON.stringify(snapshot)]), id };
}

async function snapshotIds(document: string): Promise<string[]> {
  const record: { snapshots: { id: string }[] } = JSON.parse(
    await native('workflowReadXmp', [document]),
  );
  return record.snapshots.map((snapshot) => snapshot.id);
}

interface SidecarReply {
  head?: string;
  unchanged?: boolean;
}

async function replyOf(response: Promise<Response>): Promise<SidecarReply> {
  const res = await response;
  expect(res.status).toBe(200);
  const body: SidecarReply = await res.json();
  return body;
}

describe('backup sends are reconciled from what the device sent (#5796)', () => {
  test("a digest client's next send merges from the document it sent, not the merged one", async () => {
    const target = await seedUpload('sent-base');
    const v1 = xmp('v1', { exposure: '0', contrast: '0' });
    const first = await firstSend(target, v1);
    await post(target, xmp('other', { exposure: '1', contrast: '0' }), undefined, first.head);

    const stale = xmp('B', { exposure: '0', contrast: '5' });
    expect((await post(target, stale, sha256(v1))).status).toBe(200);
    const merged = await onDisk(target.relPath);
    expect([property(merged, 'exposure'), property(merged, 'contrast')]).toEqual(['1', '5']);

    const next = xmp('C', { exposure: '0', contrast: '6' });
    expect((await post(target, next, sha256(stale))).status).toBe(200);
    const stored = await onDisk(target.relPath);
    expect([property(stored, 'exposure'), property(stored, 'contrast')]).toEqual(['1', '6']);

    // A property the device puts back is put back: the base is what it sent, not v1.
    await post(target, xmp('D', { exposure: '0', contrast: '0' }), sha256(next));
    const reverted = await onDisk(target.relPath);
    expect([property(reverted, 'exposure'), property(reverted, 'contrast')]).toEqual(['1', '0']);
  });

  test('a send acknowledged as unchanged stays a base its digest names', async () => {
    const target = await seedUpload('unchanged-lineage');
    const v1 = xmp('v1', { exposure: '0', contrast: '0' });
    const first = await firstSend(target, v1);
    // Same adjustments, different workflow metadata: nothing to write.
    const same = await withDeviceRecord(v1);
    const ack = (await (await post(target, same, sha256(v1))).json()) as { unchanged?: boolean };
    expect(ack.unchanged).toBe(true);
    await post(target, xmp('other', { exposure: '1', contrast: '0' }), undefined, first.head);

    const res = await post(target, xmp('v2', { exposure: '0', contrast: '5' }), sha256(same));
    expect(res.status).toBe(200);
    const stored = await onDisk(target.relPath);
    expect([property(stored, 'exposure'), property(stored, 'contrast')]).toEqual(['1', '5']);
  });

  test('the sent document stays the merge base after the photo is moved', async () => {
    const target = await seedUpload('moved');
    const v1 = xmp('v1', { exposure: '0', contrast: '0' });
    const first = await firstSend(target, v1);
    await post(target, xmp('other', { exposure: '1', contrast: '0' }), undefined, first.head);
    const stale = xmp('B', { exposure: '0', contrast: '5' });
    expect((await post(target, stale, sha256(v1))).status).toBe(200);

    const moved = await relocateAsset({
      id: target.assetId,
      mode: 'move',
      collision: 'auto-suffix',
      destinationPath: '2024/MOVED',
    });
    if (moved.kind !== 'relocated') throw Error(`relocate: ${moved.kind}`);
    const there = { ...target, relPath: `${moved.newPath}/${moved.newFilename}` };
    expect(property(await onDisk(there.relPath), 'exposure')).toBe('1');

    expect(
      (await post(there, xmp('C', { exposure: '0', contrast: '6' }), sha256(stale))).status,
    ).toBe(200);
    const stored = await onDisk(there.relPath);
    expect([property(stored, 'exposure'), property(stored, 'contrast')]).toEqual(['1', '6']);
  });

  test('a repeated digest names its latest send, so A → B → A → B lands every step', async () => {
    const target = await seedUpload('repeat');
    const a = xmp('A', { exposure: '1' });
    const b = xmp('B', { exposure: '2' });
    await firstSend(target, a);
    await post(target, b, sha256(a));
    await post(target, a, sha256(b));
    expect(labelOf(await onDisk(target.relPath))).toBe('A');

    const res = await post(target, b, sha256(a));
    expect(res.status).toBe(200);
    const reply = (await res.json()) as { unchanged?: boolean; head: string };
    expect(reply.unchanged).toBeUndefined();
    const stored = await onDisk(target.relPath);
    expect(labelOf(stored)).toBe('B');
    expect(property(stored, 'exposure')).toBe('2');
    const rows = await history(stored);
    expect(rows).toHaveLength(4);
    expect(rows.at(-1)?.id).toBe(reply.head);

    const retry = await post(target, b, sha256(a));
    expect(await retry.json()).toEqual({
      target_rel_path: xmpSidecarPath(target.relPath),
      unchanged: true,
      head: reply.head,
    });
    expect(await onDisk(target.relPath)).toBe(stored);
  });

  test('a first send keeps the history and named snapshots the device published', async () => {
    const target = await seedUpload('first-record');
    const plain = xmp('v1', { exposure: '0.5' });
    const checkpoint = await native('workflowCheckpointXmp', [plain]);
    const authored = {
      id: '00000000-0000-5000-8000-000000000001',
      createdAtMs: 1,
      action: 'adjustment',
      label: 'Exposure',
      parentId: '',
      writer: 'apple',
      adjustmentXmp: checkpoint,
    };
    const snapshot = {
      id: '00000000-0000-5000-8000-000000000002',
      name: 'Bright',
      createdAtMs: 2,
      adjustmentXmp: checkpoint,
    };
    const committed = await native('workflowCommitXmp', [plain, JSON.stringify(authored)]);
    const incoming = await native('workflowSnapshotXmp', [committed, JSON.stringify(snapshot)]);

    const first = await firstSend(target, incoming);
    const record = JSON.parse(await native('workflowReadXmp', [first.stored]));
    expect(record.snapshots).toEqual([snapshot]);
    expect(record.history).toHaveLength(2);
    expect(record.history[0]).toEqual(authored);
    expect(record.history[1]).toMatchObject({ id: first.head, writer: 'backup', parentId: '' });
    expect(property(first.stored, 'exposure')).toBe('0.5');
  });

  test('a snapshot taken after the first send is backed up with the next one', async () => {
    const target = await seedUpload('later-snapshot');
    const v1 = xmp('v1', { exposure: '0' });
    await firstSend(target, v1);
    const kept = await withSnapshot(v1, 1);

    expect((await replyOf(post(target, kept.xmp, sha256(v1)))).unchanged).toBeUndefined();
    expect(await snapshotIds(await onDisk(target.relPath))).toEqual([kept.id]);
    // A retry finds its own entry and adds nothing twice.
    expect((await replyOf(post(target, kept.xmp, sha256(v1)))).unchanged).toBe(true);
    expect(await snapshotIds(await onDisk(target.relPath))).toEqual([kept.id]);
  });

  test('a snapshot sent with a reconciled edit is kept beside the stored ones', async () => {
    const target = await seedUpload('reconciled-snapshot');
    const v1 = xmp('v1', { exposure: '0', contrast: '0' });
    const first = await firstSend(target, v1);
    const server = await withSnapshot(await onDisk(target.relPath), 2);
    await fs.writeFile(path.join(lib.tmpLib, xmpSidecarPath(target.relPath)), server.xmp);
    await post(target, xmp('other', { exposure: '1', contrast: '0' }), undefined, first.head);

    const device = await withSnapshot(xmp('B', { exposure: '0', contrast: '5' }), 3);
    await replyOf(post(target, device.xmp, sha256(v1)));
    const stored = await onDisk(target.relPath);
    expect([property(stored, 'exposure'), property(stored, 'contrast')]).toEqual(['1', '5']);
    expect(await snapshotIds(stored)).toEqual([server.id, device.id]);
  });

  test('a publish that fails keeps the sent documents of the history still on disk', async () => {
    const target = await seedUpload('failed-compaction');
    const v1 = xmp('v1', { exposure: '0', contrast: '0' });
    const first = await firstSend(target, v1);
    const other = async (n: number, base: string) => {
      const body = xmp(`other ${n}`, { exposure: '1', contrast: '5', n: `${n}` });
      return (await replyOf(post(target, body, undefined, base))).head!;
    };
    await other(0, first.head);
    const stale = xmp('B', { exposure: '0', contrast: '5' });
    const merged = (await replyOf(post(target, stale, sha256(v1)))).head!;
    // 31 more entries retire the two before it: the merged send is now the oldest.
    let head = merged;
    for (let n = 1; n <= 31; n++) head = await other(n, head);
    const rows = await history(await onDisk(target.relPath));
    expect([rows.length, rows[0]!.id]).toEqual([32, merged]);

    // The next entry would retire it, but the publish fails.
    const dir = path.dirname(path.join(lib.tmpLib, target.relPath));
    await fs.chmod(dir, 0o555);
    try {
      const res = await post(
        target,
        xmp('lost', { exposure: '1', contrast: '9' }),
        undefined,
        head,
      );
      expect(res.status).toBe(500);
    } finally {
      await fs.chmod(dir, 0o755);
    }

    await replyOf(post(target, xmp('C', { exposure: '0', contrast: '6' }), sha256(stale)));
    const stored = await onDisk(target.relPath);
    expect([property(stored, 'exposure'), property(stored, 'contrast')]).toEqual(['1', '6']);
  });

  test('a send matching an outside edit is answered with a head that holds it', async () => {
    const target = await seedUpload('ahead-of-history');
    const first = await firstSend(target, xmp('v1', { exposure: '0' }));
    const sidecar = path.join(lib.tmpLib, xmpSidecarPath(target.relPath));
    await fs.writeFile(sidecar, first.stored.replace(' test:exposure="0"', ' test:exposure="1"'));

    // The head-based client resends the document the file now holds.
    const ack = await replyOf(post(target, await onDisk(target.relPath), undefined, first.head));
    expect(ack.head).not.toBe(first.head);
    const head = (await history(await onDisk(target.relPath))).at(-1)!.id;
    await replyOf(post(target, xmp('other', { exposure: '2' }), undefined, head));

    const next = xmp('v1', { exposure: '1', contrast: '5' });
    await replyOf(post(target, next, undefined, ack.head));
    const stored = await onDisk(target.relPath);
    expect([property(stored, 'exposure'), property(stored, 'contrast')]).toEqual(['2', '5']);
  });

  test("a copy's sends stay while its sidecar holds them, though the other copy moved on", async () => {
    const target = await seedUpload('two-copies');
    const v1 = xmp('v1', { exposure: '0', contrast: '0' });
    const first = await firstSend(target, v1);
    await post(target, xmp('other', { exposure: '1', contrast: '0' }), undefined, first.head);
    const stale = xmp('B', { exposure: '0', contrast: '5' });
    await replyOf(post(target, stale, sha256(v1)));

    // A second live copy of the photo with the same sidecar, holding the merged send.
    const copy = { ...target, relPath: '2024/COPY/two-copies.HEIC' };
    await fs.mkdir(path.join(lib.tmpLib, '2024/COPY'), { recursive: true });
    for (const file of [target.relPath, xmpSidecarPath(target.relPath)]) {
      const to = file.replace('2024/CAS/', '2024/COPY/');
      await fs.copyFile(path.join(lib.tmpLib, file), path.join(lib.tmpLib, to));
    }
    insertLocation(lib.live.db, {
      assetId: target.assetId.toHexString(),
      libraryId: lib.libId.toHexString(),
      ordinal: 1,
      path: '2024/COPY',
      filename: 'two-copies.HEIC',
    });

    // The first copy's history moves on until the merged send is retired from it.
    let head = (await history(await onDisk(target.relPath))).at(-1)!.id;
    for (let n = 0; n < 34; n++) {
      const body = xmp(`other ${n}`, { exposure: '1', contrast: '5', n: `${n}` });
      head = (await replyOf(post(target, body, undefined, head))).head!;
    }

    await replyOf(post(copy, xmp('C', { exposure: '0', contrast: '6' }), sha256(stale)));
    const stored = await onDisk(copy.relPath);
    expect([property(stored, 'exposure'), property(stored, 'contrast')]).toEqual(['1', '6']);
  });

  test('a send matching a sidecar without history is answered with a head that holds it', async () => {
    const target = await seedUpload('historyless');
    const v1 = xmp('v1', { exposure: '1' });
    // The legacy (no base) upload stores the document as sent, without a history.
    await replyOf(post(target, v1, undefined));
    expect(await native('workflowReadXmp', [await onDisk(target.relPath)])).toBe('null');

    const ack = await replyOf(post(target, v1, undefined, 'none'));
    const stored = JSON.parse(await native('workflowReadXmp', [await onDisk(target.relPath)]));
    const other = stored?.history.at(-1)?.id ?? 'none';
    await replyOf(post(target, xmp('other', { exposure: '2' }), undefined, other));

    // The head-based client names what it was answered with (`none` without a head).
    await replyOf(
      post(target, xmp('v1', { exposure: '1', contrast: '5' }), undefined, ack.head ?? 'none'),
    );
    const after = await onDisk(target.relPath);
    expect([property(after, 'exposure'), property(after, 'contrast')]).toEqual(['2', '5']);
    expect(ack.head).toBeDefined();
    // Sent again, the same document now finds its own entry.
    expect(await replyOf(post(target, v1, undefined, 'none'))).toMatchObject({
      unchanged: true,
      head: ack.head,
    });
  });
});
