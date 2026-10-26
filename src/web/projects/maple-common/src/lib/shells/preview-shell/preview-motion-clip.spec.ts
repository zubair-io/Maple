import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { describe, expect, it, vi } from 'vitest';
import type { Asset } from '../../models/asset';
import { STUB_ASSET } from './preview-shell.test-helpers';
import { motionClipApiPath, PreviewMotionClip } from './preview-motion-clip';

const ACCESS = { apiBase: 'https://maple.test/api', bearer: () => 'token-1' };

function asset(overrides: Partial<Asset>): Asset {
  return { ...STUB_ASSET, ...overrides };
}

function setup(probeResult: boolean, initial: Asset | null = asset({})) {
  TestBed.resetTestingModule();
  const focused = signal<Asset | null>(initial);
  const probe = vi.fn((_url: string) => Promise.resolve(probeResult));
  const motion = TestBed.runInInjectionContext(() => new PreviewMotionClip(focused, ACCESS, probe));
  return { focused, probe, motion };
}

async function settle(): Promise<void> {
  TestBed.tick();
  await Promise.resolve();
  await Promise.resolve();
}

describe('motionClipApiPath', () => {
  it('addresses JPEG and HEIC stills only', () => {
    expect(
      motionClipApiPath(asset({ id: 'phone:2026/PXL_1.MP.jpg', filename: 'PXL_1.MP.jpg' })),
    ).toBe('phone/2026/PXL_1.MP.jpg');
    expect(motionClipApiPath(asset({ id: 'phone:a.HEIC', filename: 'a.HEIC' }))).toBe(
      'phone/a.HEIC',
    );
    expect(motionClipApiPath(asset({ id: 'phone:a.dng', filename: 'a.dng' }))).toBeUndefined();
    expect(
      motionClipApiPath(asset({ id: 'phone:a.jpg', filename: 'a.jpg', isVideo: true })),
    ).toBeUndefined();
    expect(motionClipApiPath(null)).toBeUndefined();
  });
});

describe('PreviewMotionClip', () => {
  it('probes the focused still with the access token and offers playback when a clip exists', async () => {
    const { probe, motion } = setup(true);
    await settle();
    expect(probe).toHaveBeenCalledWith(
      'https://maple.test/api/motion/library/2026/a.jpg?token=token-1',
    );
    expect(motion.available()).toBe(true);
    expect(motion.src()).toBeUndefined();

    motion.toggle();
    expect(motion.src()).toBe('https://maple.test/api/motion/library/2026/a.jpg?token=token-1');
    motion.stop();
    expect(motion.src()).toBeUndefined();
  });

  it('never plays a still the server has no clip for', async () => {
    const { motion } = setup(false);
    await settle();
    motion.toggle();
    expect(motion.available()).toBe(false);
    expect(motion.src()).toBeUndefined();
  });

  it('stops playback and re-probes when focus moves to another still', async () => {
    const { focused, probe, motion } = setup(true);
    await settle();
    motion.toggle();
    focused.set(asset({ id: 'library:2026/b.jpg', filename: '2026/b.jpg' }));
    TestBed.tick();
    expect(motion.playing()).toBe(false);
    expect(motion.available()).toBe(false);
    await settle();
    expect(probe).toHaveBeenLastCalledWith(
      'https://maple.test/api/motion/library/2026/b.jpg?token=token-1',
    );
    expect(motion.available()).toBe(true);
  });

  it('ignores a probe answer that arrives after focus moved on', async () => {
    const resolvers: ((ok: boolean) => void)[] = [];
    TestBed.resetTestingModule();
    const focused = signal<Asset | null>(asset({}));
    const motion = TestBed.runInInjectionContext(
      () =>
        new PreviewMotionClip(
          focused,
          ACCESS,
          () => new Promise((resolve) => resolvers.push(resolve)),
        ),
    );
    TestBed.tick();
    focused.set(asset({ id: 'library:x.dng', filename: 'x.dng' }));
    TestBed.tick();
    resolvers[0]!(true);
    await settle();
    expect(motion.available()).toBe(false);
  });
});
