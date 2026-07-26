// GpuLiveRenderGate — the effective GPU live-render state (#1062).
//
// The gate is what makes the DB-backed setting usable as a kill switch, so the
// properties under test are: the unset default preserves today's behaviour, an
// operator "off" wins, the localStorage warm start applies before any network
// call, and the build-time token remains a hard floor.

import { TestBed } from '@angular/core/testing';
import { describe, it, expect, beforeEach } from 'vitest';

import { GpuLiveRenderGate } from './gpu-live-render.gate';
import { GPU_LIVE_RENDER_ENABLED } from './gpu-live-render.token';
import { STORAGE_KEYS, TypedStorage } from '../util/typed-storage';

function gate(buildEnabled?: boolean): GpuLiveRenderGate {
  TestBed.configureTestingModule({
    providers:
      buildEnabled === undefined
        ? []
        : [{ provide: GPU_LIVE_RENDER_ENABLED, useValue: buildEnabled }],
  });
  return TestBed.inject(GpuLiveRenderGate);
}

describe('GpuLiveRenderGate (#1062)', () => {
  beforeEach(() => {
    TypedStorage.remove(STORAGE_KEYS.GPU_LIVE_RENDER_ENABLED);
    TestBed.resetTestingModule();
  });

  it('defaults to enabled when the operator has never saved a value', () => {
    // The acceptance criterion: unset === today's behaviour (GPU on).
    const g = gate();
    expect(g.enabled()).toBe(true);
    expect(g.hasOperatorValue()).toBe(false);
  });

  it('applying false kills the GPU path', () => {
    const g = gate();
    g.apply(false);
    expect(g.enabled()).toBe(false);
    expect(g.hasOperatorValue()).toBe(true);
  });

  it('applying true ramps it back on', () => {
    const g = gate();
    g.apply(false);
    g.apply(true);
    expect(g.enabled()).toBe(true);
  });

  it('caches the applied value so the next cold start is off with no network', () => {
    // This is the kill-switch property: a browser that has once been told
    // "off" starts up off, synchronously, before any render can begin.
    gate().apply(false);
    expect(TypedStorage.get<boolean>(STORAGE_KEYS.GPU_LIVE_RENDER_ENABLED)).toBe(false);

    TestBed.resetTestingModule();
    const fresh = gate();
    expect(fresh.enabled()).toBe(false);
    expect(fresh.hasOperatorValue()).toBe(true);
  });

  it('warm-starts enabled from a cached true', () => {
    TypedStorage.set(STORAGE_KEYS.GPU_LIVE_RENDER_ENABLED, true);
    const g = gate();
    expect(g.enabled()).toBe(true);
    expect(g.hasOperatorValue()).toBe(true);
  });

  it('a build-time token of false is a hard floor the setting cannot lift', () => {
    // Deploy-time off (and, on Apple, MAPLE_GPU_LIVE=0) is the last-resort
    // override: the DB setting can turn the GPU path off, never back on.
    const g = gate(false);
    expect(g.enabled()).toBe(false);
    g.apply(true);
    expect(g.enabled()).toBe(false);
  });

  it('is idempotent — re-applying the same value is a no-op', () => {
    const g = gate();
    g.apply(true);
    expect(g.hasOperatorValue()).toBe(true);
    g.apply(true);
    expect(g.enabled()).toBe(true);
  });
});
