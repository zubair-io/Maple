/**
 * mirror scan-now runner — guard test. Pure (no Mongo): when no mirror is
 * configured the runner must refuse to start (and never flip into 'scanning'),
 * so the "Scan now" button can't kick a pointless walk.
 */

import { describe, it, expect, beforeEach } from 'bun:test';
import { clearMirrorRoots } from '../fs/mirror-registry.ts';
import { getMirrorScanProgress, startMirrorScanNow } from './mirror-scan-runner.ts';

describe('mirror scan-now runner', () => {
  beforeEach(() => clearMirrorRoots());

  it('refuses to start when no mirror is configured', () => {
    const res = startMirrorScanNow();
    expect(res.started).toBe(false);
    expect(res.reason).toBe('no mirror configured');
    expect(getMirrorScanProgress().phase).toBe('idle');
  });
});
