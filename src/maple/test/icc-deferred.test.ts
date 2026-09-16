import { expect, it } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { AuxBlob } from '../src/recipe';
import { createBuilderState } from '../src/builder-state';
import { applyWithIccProfile } from '../src/builder-metadata';

it('shares one pending read across concurrent executions and keeps mixed offsets intact', async () => {
  const aux = new AuxBlob();
  const first = aux.add(new Uint8Array([1, 2]));
  let calls = 0;
  const release = Promise.withResolvers<Uint8Array>();
  const pending = aux.addPending(() => {
    calls++;
    return release.promise;
  });
  const last = aux.add(new Uint8Array([6]));
  expect(calls).toBe(0);
  const a = aux.resolve();
  const b = aux.resolve();
  release.resolve(new Uint8Array([3, 4, 5]));
  await Promise.all([a, b]);
  expect(calls).toBe(1);
  expect([first, pending, last]).toEqual([
    { off: 0, len: 2 },
    { off: 2, len: 3 },
    { off: 5, len: 1 },
  ]);
  expect([...aux.bytes()]).toEqual([1, 2, 3, 4, 5, 6]);
  await aux.resolve();
  expect(calls).toBe(1);
});

it('does not read a superseded ICC path for named, byte or path replacements', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'maple-icc-'));
  try {
    const good = path.join(dir, 'good.icc');
    await fs.writeFile(good, new Uint8Array([1, 2, 3]));
    for (const replacement of ['srgb', new Uint8Array([1, 2, 3]), good]) {
      const state = createBuilderState(new Uint8Array([1]));
      applyWithIccProfile(state, path.join(dir, 'missing.icc'));
      applyWithIccProfile(state, replacement);
      await state.aux.resolve();
      expect([...state.aux.bytes()]).toEqual(replacement === 'srgb' ? [] : [1, 2, 3]);
    }
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

it('opens ICC at execution, caches success and permits retry after a missing file', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'maple-icc-'));
  try {
    const profile = path.join(dir, 'later.icc');
    const state = createBuilderState(new Uint8Array([1]));
    applyWithIccProfile(state, profile);
    await expect(state.aux.resolve()).rejects.toThrow('withIccProfile: cannot read ICC profile');
    await fs.writeFile(profile, new Uint8Array([7, 8]));
    await state.aux.resolve();
    await fs.unlink(profile);
    await state.aux.resolve();
    expect([...state.aux.bytes()]).toEqual([7, 8]);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

it('terminal calls load the current file bytes and preserve adjacent XMP payloads', async () => {
  const { maple } = await import('../src/index');
  const pixels = {
    data: new Uint8Array(8 * 8 * 3).fill(100),
    width: 8,
    height: 8,
    channels: 3 as const,
  };
  const srgb = (await maple(await maple(pixels).withIccProfile('srgb').png().toBuffer()).metadata())
    .icc!;
  const p3 = (await maple(await maple(pixels).withIccProfile('p3').png().toBuffer()).metadata())
    .icc!;
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'maple-icc-'));
  try {
    const profile = path.join(dir, 'profile.icc');
    await fs.writeFile(profile, srgb);
    const image = maple(pixels)
      .withIccProfile(profile)
      .withXmp('<x:xmpmeta xmlns:x="adobe:ns:meta/">pending</x:xmpmeta>')
      .png();
    // The fluent method must not snapshot the old bytes synchronously.
    await fs.writeFile(profile, p3);
    const output = path.join(dir, 'output.png');
    const [buffer, file] = await Promise.all([image.toBuffer(), image.toFile(output)]);
    expect(file.ok).toBe(true);
    for (const bytes of [buffer, await fs.readFile(output)]) {
      const metadata = await maple(bytes).metadata();
      expect(metadata.icc?.equals(p3)).toBe(true);
      expect(metadata.xmp?.toString()).toContain('pending');
    }
    await fs.unlink(profile);
    expect((await maple(await image.toBuffer()).metadata()).icc?.equals(p3)).toBe(true);

    const missing = maple(pixels).withIccProfile(profile).png();
    const originalOutput = await fs.readFile(output);
    await expect(missing.toBuffer()).rejects.toThrow('withIccProfile: cannot read ICC profile');
    const failed = await missing.toFile(output);
    expect(failed.ok).toBe(false);
    expect(failed.error).toContain('withIccProfile: cannot read ICC profile');
    expect((await fs.readFile(output)).equals(originalOutput)).toBe(true);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

it('shares a pending failure and retries the loader on the next execution', async () => {
  const aux = new AuxBlob();
  const first = Promise.withResolvers<Uint8Array>();
  let calls = 0;
  aux.addPending(() => (++calls === 1 ? first.promise : Promise.resolve(new Uint8Array([9]))));
  const results = Promise.allSettled([aux.resolve(), aux.resolve()]);
  first.reject(new Error('read failed'));
  expect((await results).map((r) => r.status)).toEqual(['rejected', 'rejected']);
  expect(calls).toBe(1);
  await aux.resolve();
  expect(calls).toBe(2);
  expect([...aux.bytes()]).toEqual([9]);
});
