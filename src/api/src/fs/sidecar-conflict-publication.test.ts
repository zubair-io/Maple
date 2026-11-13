import { expect, test } from 'bun:test';
import * as path from 'node:path';
import { recoveryFixture } from '../cloud-backup/restore.test-helpers.ts';
import { readFile, writeFile } from './mirrored.ts';
import { publishConflictBytes } from './sidecar-ownership.ts';
import { serializeSidecarWrite, serializeSidecarWrites } from './sidecar-write-order.ts';
import { writeConflictSidecarAtomic } from './xmp-conflict.ts';

test('an in-flight conflict edit owns the destination before a carried edit can publish', async () => {
  const f = await recoveryFixture();
  const photo = path.join(f.root, 'photo.dng');
  const conflict = path.join(f.root, 'photo (conflict from move).xmp');
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const holder = serializeSidecarWrite(conflict, async () => {
    entered.resolve();
    await release.promise;
  });
  await entered.promise;
  let finished = false;
  const editing = writeConflictSidecarAtomic(
    photo,
    'photo (conflict from move)',
    'other edit',
  ).then((result) => {
    finished = true;
    return result;
  });
  try {
    await Bun.sleep(30);
    expect(finished).toBe(false);
    expect(await publishConflictBytes(photo, Buffer.from('carried edit'))).toBe(false);
    release.resolve();
    await holder;
    expect((await editing).ok).toBe(true);
    expect(await publishConflictBytes(photo, Buffer.from('carried edit'))).toBe(true);
    expect(await readFile(conflict, 'utf8')).toBe('other edit');
    expect(await readFile(path.join(f.root, 'photo (conflict from move) (2).xmp'), 'utf8')).toBe(
      'carried edit',
    );
  } finally {
    release.resolve();
    await holder;
    await editing;
    await f.close();
  }
});

test('conflict publication never waits on a relocate queued behind its held source', async () => {
  const f = await recoveryFixture();
  const photo = path.join(f.root, 'photo.dng');
  const source = path.join(f.root, 'source.xmp');
  const conflict = path.join(f.root, 'photo (conflict from move).xmp');
  await writeFile(source, 'carried edit');
  let moving: Promise<void> | undefined;
  try {
    await serializeSidecarWrite(source, async () => {
      moving = serializeSidecarWrites([source, conflict], async () => {
        await writeFile(conflict, 'relocated edit');
      });
      // Admission for the queued multi-path relocate precedes publication.
      expect(await publishConflictBytes(photo, Buffer.from('carried edit'))).toBe(false);
      expect(await readFile(source, 'utf8')).toBe('carried edit');
    });
    await moving;
    expect(await readFile(conflict, 'utf8')).toBe('relocated edit');
  } finally {
    await moving;
    await f.close();
  }
});
