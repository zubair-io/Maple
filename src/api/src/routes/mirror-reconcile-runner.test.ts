/**
 * mirror reconcile-now runner — guard test. Pure (no Mongo): when no mirror is
 * configured the runner must refuse to start (and never flip out of 'idle'), so
 * the "Reconcile now" button can't kick a pointless scan+copy.
 */

import { describe, it, expect, beforeEach } from 'bun:test';
import { clearMirrorRoots } from '../fs/mirror-registry.ts';
import { getMirrorReconcileProgress, startMirrorReconcileNow } from './mirror-reconcile-runner.ts';

describe('mirror reconcile-now runner', () => {
  beforeEach(() => clearMirrorRoots());

  it('refuses to start when no mirror is configured', () => {
    const res = startMirrorReconcileNow();
    expect(res.started).toBe(false);
    expect(res.reason).toBe('no mirror configured');
    expect(getMirrorReconcileProgress().phase).toBe('idle');
  });

  it('exposes an empty copied-files log before any run', () => {
    const p = getMirrorReconcileProgress();
    expect(p.copiedLog).toEqual([]);
    expect(p.errorLog).toEqual([]);
  });

  it('returns a defensive snapshot — mutating the log arrays does not leak back', () => {
    const a = getMirrorReconcileProgress();
    a.copiedLog.push('/leak.dng');
    a.errorLog.push({ path: '/leak.dng', error: 'nope', at: new Date().toISOString() });
    const b = getMirrorReconcileProgress();
    expect(b.copiedLog).toEqual([]);
    expect(b.errorLog).toEqual([]);
  });
});
