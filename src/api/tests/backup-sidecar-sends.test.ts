/**
 * A backup send is placed on the edit history by what the device actually sent
 * (#5796): a digest base merges from the sent document even when the server
 * reconciled it into something else, a repeated digest names its latest send,
 * and a first send keeps the authoring record (history and named snapshots)
 * the device published into the file.
 *
 * Real temp library files, real XMP documents and a private SQLite database.
 */
import { describe, test, expect } from 'bun:test';
import { callNative } from 'maple';
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
});
