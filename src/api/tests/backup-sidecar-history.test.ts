/**
 * A backup sidecar re-send reconciles through the sidecar's edit history instead
 * of being parked in `sidecar_divergences` (#5796): a stale send is applied on
 * top and recorded, racing and retried sends lose nothing, and unknown XML of
 * the stored sidecar survives byte for byte.
 *
 * Real temp library files, real XMP documents and a private SQLite database.
 */
import { describe, test, expect } from 'bun:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { xmpSidecarPath } from '../src/fs/xmp.ts';
import {
  deviceId,
  history,
  labelOf,
  property,
  sha256,
  useSidecarLibrary,
  xmp,
} from './helpers/backup-sidecar-fixtures.ts';

const lib = useSidecarLibrary();
const { seedUpload, post, onDisk, divergences, firstSend } = lib;

const lightroom = await fs.readFile(
  new URL('../../../test-fixtures/local-adjustments/lightroom-group-add.xmp', import.meta.url),
  'utf8',
);

describe('backup sidecar reconcile through the edit history (#5796)', () => {
  test('a stale re-send is applied on top and recorded, and nothing is lost', async () => {
    const target = await seedUpload('stale');
    const first = await firstSend(target, xmp('v1', { exposure: '0', contrast: '0' }));
    const other = await post(
      target,
      xmp('other device', { exposure: '1', contrast: '0' }),
      undefined,
      first.head,
    );
    const otherHead = ((await other.json()) as { head: string }).head;

    const res = await post(
      target,
      xmp('v2', { exposure: '0', contrast: '9' }),
      undefined,
      first.head,
    );
    expect(res.status).toBe(200);
    const reply = (await res.json()) as { reconciled?: boolean; head: string };
    expect(reply.reconciled).toBe(true);

    const stored = await onDisk(target.relPath);
    expect(labelOf(stored)).toBe('v2');
    expect(property(stored, 'exposure')).toBe('1');
    expect(property(stored, 'contrast')).toBe('9');
    const rows = await history(stored);
    expect(rows.map((row) => row.id)).toEqual([first.head, otherHead, reply.head]);
    expect(rows[2]).toMatchObject({ parentId: first.head, writer: 'backup' });
    expect(labelOf(rows[1]!.adjustmentXmp)).toBe('other device');
    expect(divergences(target.relPath)).toEqual([]);
  });

  test('when both sides changed a property the re-send wins and the other value stays in the history', async () => {
    const target = await seedUpload('conflict');
    const first = await firstSend(target, xmp('v1', { exposure: '0' }));
    await post(target, xmp('A', { exposure: '1' }), undefined, first.head);

    const res = await post(target, xmp('B', { exposure: '2' }), undefined, first.head);
    expect(res.status).toBe(200);
    const stored = await onDisk(target.relPath);
    expect(property(stored, 'exposure')).toBe('2');
    const rows = await history(stored);
    expect(property(rows[1]!.adjustmentXmp, 'exposure')).toBe('1');
  });

  test('a stale digest base is resolved through the history the same way', async () => {
    const target = await seedUpload('stale-digest');
    await firstSend(target, xmp('v1', { exposure: '0', contrast: '0' }));
    const base = sha256(xmp('v1', { exposure: '0', contrast: '0' }));
    await post(
      target,
      xmp('other', { exposure: '1', contrast: '0' }),
      undefined,
      (await history(await onDisk(target.relPath)))[0]!.id,
    );

    const res = await post(target, xmp('v2', { exposure: '0', contrast: '5' }), base);
    expect(((await res.json()) as { reconciled?: boolean }).reconciled).toBe(true);
    const stored = await onDisk(target.relPath);
    expect(property(stored, 'exposure')).toBe('1');
    expect(property(stored, 'contrast')).toBe('5');
  });

  test('an outside edit made since is recorded as an external entry and kept', async () => {
    const target = await seedUpload('outside');
    const first = await firstSend(target, xmp('v1', { exposure: '0' }));
    await fs.writeFile(
      path.join(lib.tmpLib, xmpSidecarPath(target.relPath)),
      first.stored.replace(' test:exposure="0"', ' test:exposure="0" test:sharpness="40"'),
    );

    const res = await post(target, xmp('v2', { exposure: '3' }), undefined, first.head);
    expect(res.status).toBe(200);
    const stored = await onDisk(target.relPath);
    expect(property(stored, 'sharpness')).toBe('40');
    expect(property(stored, 'exposure')).toBe('3');
    const rows = await history(stored);
    expect(rows.map((row) => row.action)).toEqual(['adjustment', 'external', 'adjustment']);
    expect(property(rows[1]!.adjustmentXmp, 'sharpness')).toBe('40');
  });

  test("a first send over another device's sidecar lands on top and records theirs", async () => {
    const target = await seedUpload('dedup');
    expect((await post(target, xmp('device A', { a: '1' }), undefined)).status).toBe(200);

    const res = await post(target, xmp('device B', { b: '2' }), 'none');
    expect(res.status).toBe(200);
    expect(((await res.json()) as { reconciled?: boolean }).reconciled).toBe(true);
    const stored = await onDisk(target.relPath);
    expect(labelOf(stored)).toBe('device B');
    expect(property(stored, 'a')).toBe('1');
    expect(property(stored, 'b')).toBe('2');
    const rows = await history(stored);
    expect(rows.map((row) => row.action)).toEqual(['external', 'adjustment']);
    expect(labelOf(rows[0]!.adjustmentXmp)).toBe('device A');
    expect(divergences(target.relPath)).toEqual([]);
  });

  test('a retried stale send is acknowledged with its own entry and writes nothing', async () => {
    const target = await seedUpload('retry');
    const first = await firstSend(target, xmp('v1', { exposure: '0', contrast: '0' }));
    await post(target, xmp('A', { exposure: '1', contrast: '0' }), undefined, first.head);
    const send = xmp('B', { exposure: '0', contrast: '4' });
    const applied = (await (await post(target, send, undefined, first.head)).json()) as {
      head: string;
    };
    const stored = await onDisk(target.relPath);
    await post(
      target,
      xmp('C', { exposure: '0', contrast: '0', other: '1' }),
      undefined,
      applied.head,
    );
    const later = await onDisk(target.relPath);

    const retry = await post(target, send, undefined, first.head);
    expect(await retry.json()).toEqual({
      target_rel_path: xmpSidecarPath(target.relPath),
      unchanged: true,
      head: applied.head,
    });
    expect(await onDisk(target.relPath)).toBe(later);
    expect(stored).not.toBe(later);
  });

  test('a head the history no longer holds is reconciled without a recorded base', async () => {
    const target = await seedUpload('unknown-head');
    await firstSend(target, xmp('v1', { exposure: '0' }));

    const res = await post(target, xmp('v2', { contrast: '2' }), undefined, crypto.randomUUID());
    expect(((await res.json()) as { reconciled?: boolean }).reconciled).toBe(true);
    const stored = await onDisk(target.relPath);
    expect(property(stored, 'exposure')).toBe('0');
    expect(property(stored, 'contrast')).toBe('2');
    expect((await history(stored)).at(-1)?.parentId).toBe('');
  });

  test('unknown elements of the stored sidecar survive a reconciled re-send byte for byte', async () => {
    const target = await seedUpload('lightroom');
    const first = await firstSend(target, lightroom);
    const masks = /<crs:MaskGroupBasedCorrections>[\s\S]*<\/crs:MaskGroupBasedCorrections>/.exec(
      lightroom,
    )![0];
    const interior = masks.slice(masks.indexOf('\n'));
    expect(first.stored).toContain(interior);
    await post(
      target,
      lightroom.replace(
        'crs:ProcessVersion="15.4"',
        'crs:ProcessVersion="15.4" crs:Sharpness="40"',
      ),
      undefined,
      first.head,
    );

    const res = await post(
      target,
      lightroom.replace(
        'crs:ProcessVersion="15.4"',
        'crs:ProcessVersion="15.4" crs:Exposure2012="0.5"',
      ),
      undefined,
      first.head,
    );
    expect(((await res.json()) as { reconciled?: boolean }).reconciled).toBe(true);
    const stored = await onDisk(target.relPath);
    expect(stored).toContain(interior);
    expect(stored).toContain('crs:Sharpness="40"');
    expect(stored).toContain('crs:Exposure2012="0.5"');
  });

  test('edits racing on the same head all land, each as its own entry', async () => {
    const target = await seedUpload('race');
    const first = await firstSend(target, xmp('v1'));

    const names = ['a', 'b', 'c', 'd', 'e', 'f'];
    const replies = await Promise.all(
      names.map((name) => post(target, xmp('v1', { [name]: '1' }), undefined, first.head)),
    );
    expect(replies.map((reply) => reply.status)).toEqual(names.map(() => 200));
    const heads = await Promise.all(
      replies.map(async (reply) => ((await reply.json()) as { head: string }).head),
    );

    const stored = await onDisk(target.relPath);
    for (const name of names) expect(property(stored, name)).toBe('1');
    const rows = await history(stored);
    expect(rows).toHaveLength(names.length + 1);
    expect(new Set(rows.map((row) => row.id))).toEqual(new Set([first.head, ...heads]));
    expect(divergences(target.relPath)).toEqual([]);
  });

  test('the same edit racing with itself lands once', async () => {
    const target = await seedUpload('race-same');
    const first = await firstSend(target, xmp('v1'));
    const send = xmp('v2', { exposure: '2' });

    const [a, b] = await Promise.all([
      post(target, send, undefined, first.head),
      post(target, send, undefined, first.head),
    ]);
    const bodies = (await Promise.all([a.json(), b.json()])) as {
      unchanged?: boolean;
      head: string;
    }[];
    expect(bodies.filter((body) => body.unchanged)).toHaveLength(1);
    expect(bodies[0]?.head).toBe(bodies[1]?.head);
    expect(await history(await onDisk(target.relPath))).toHaveLength(2);
  });

  test('divergence rows recorded before the history existed are left as they are', async () => {
    const target = await seedUpload('old-rows');
    const first = await firstSend(target, xmp('v1', { exposure: '0' }));
    lib.live.db
      .query(
        `INSERT INTO sidecar_divergences (id, asset_id, library_id, sidecar_rel_path, device_id,
           base_sha256, displaced_sha256, displaced_xmp, incoming_sha256, created_at)
         VALUES ('bbbbbbbbbbbbbbbbbbbbbbbb', ?, ?, ?, ?, NULL, ?, ?, ?, ?)`,
      )
      .run(
        target.assetId.toHexString(),
        lib.libId.toHexString(),
        xmpSidecarPath(target.relPath),
        deviceId,
        sha256('old'),
        'old',
        sha256('new'),
        new Date().toISOString(),
      );
    await post(target, xmp('other', { exposure: '1' }), undefined, first.head);
    await post(target, xmp('v2', { exposure: '2' }), undefined, first.head);

    expect(divergences(target.relPath)).toMatchObject([{ displaced_xmp: 'old' }]);
  });

  test('a sibling-shared sidecar is replaced only by a send naming its exact head (#4692)', async () => {
    const target = await seedUpload('shared');
    const first = await firstSend(target, xmp('v1', { exposure: '0' }));
    await fs.writeFile(path.join(lib.tmpLib, '2024/CAS/shared.cr2'), Buffer.alloc(8));
    await post(target, xmp('sibling', { exposure: '1' }), undefined, first.head);
    const siblingState = await onDisk(target.relPath);

    const stale = await post(target, xmp('mine', { exposure: '2' }), undefined, first.head);
    expect(await stale.json()).toEqual({
      target_rel_path: xmpSidecarPath(target.relPath),
      shared: true,
    });
    await post(target, xmp('mine', { exposure: '2' }), undefined, first.head);
    expect(await onDisk(target.relPath)).toBe(siblingState);
    expect(divergences(target.relPath)).toHaveLength(1);

    const head = (await history(siblingState)).at(-1)!.id;
    const exact = await post(target, xmp('mine', { exposure: '2' }), undefined, head);
    expect(exact.status).toBe(200);
    expect(((await exact.json()) as { shared?: boolean }).shared).toBeUndefined();
    expect(property(await onDisk(target.relPath), 'exposure')).toBe('2');
  });
});
