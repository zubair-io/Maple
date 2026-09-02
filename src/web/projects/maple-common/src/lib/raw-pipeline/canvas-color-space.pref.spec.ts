// CanvasColorSpacePref — the web half of the #1338 P3 toggle (#3191).
//
// Properties under test: the unset default follows the gamut probe (not a
// hardcoded value), a saved choice overrides it, corrupt/out-of-range
// storage is rejected rather than propagated, and — the Copilot review
// finding on #3224 — `current()` re-probes the gamut on every call instead
// of memoizing the first result (it's a plain method, not a `computed()`,
// specifically so a display-gamut change mid-session isn't stuck stale).

import { TestBed } from '@angular/core/testing';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { CanvasColorSpacePref, isCanvasColorSpace } from './canvas-color-space.pref';
import { STORAGE_KEYS, TypedStorage } from '../util/typed-storage';

let originalMatchMedia: typeof window.matchMedia | undefined;
let capturedOriginal = false;

function stubGamut(supportsP3: boolean): void {
  if (!capturedOriginal) {
    originalMatchMedia = window.matchMedia;
    capturedOriginal = true;
  }
  window.matchMedia = ((query: string) => ({
    matches: query.includes('p3') ? supportsP3 : false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

function pref(): CanvasColorSpacePref {
  TestBed.configureTestingModule({});
  return TestBed.inject(CanvasColorSpacePref);
}

describe('CanvasColorSpacePref (#3191)', () => {
  beforeEach(() => {
    TypedStorage.remove(STORAGE_KEYS.CANVAS_COLOR_SPACE);
    TestBed.resetTestingModule();
  });

  afterEach(() => {
    TypedStorage.remove(STORAGE_KEYS.CANVAS_COLOR_SPACE);
    window.matchMedia = originalMatchMedia as typeof window.matchMedia;
    originalMatchMedia = undefined;
    capturedOriginal = false;
  });

  it('defaults to display-p3 when the screen reports the P3 gamut', () => {
    stubGamut(true);
    expect(pref().current()).toBe('display-p3');
  });

  it('defaults to srgb when the screen does not report the P3 gamut', () => {
    stubGamut(false);
    expect(pref().current()).toBe('srgb');
  });

  it('a saved choice overrides the gamut-probed default', () => {
    stubGamut(true);
    const p = pref();
    p.set('srgb');
    expect(p.current()).toBe('srgb');
    expect(p.isExplicit()).toBe(true);
  });

  it('rejects a corrupt/out-of-range stored value and falls back to the default', () => {
    stubGamut(true);
    TypedStorage.set(STORAGE_KEYS.CANVAS_COLOR_SPACE, 'adobe-rgb');
    const p = pref();
    expect(p.current()).toBe('display-p3');
    expect(p.isExplicit()).toBe(false);
  });

  it('re-probes the gamut on every call instead of memoizing the first result', () => {
    // Copilot review (#3224): `current` used to be a `computed()`, whose
    // dependency is `stored` (a signal) only — `screenSupportsP3()` reads
    // `window.matchMedia` directly, which Angular can't track, so a
    // `computed` would cache the FIRST probe result forever. Flipping the
    // stub mid-test and re-reading `current()` proves it's live, not cached.
    stubGamut(true);
    const p = pref();
    expect(p.current()).toBe('display-p3');
    stubGamut(false);
    expect(p.current()).toBe('srgb');
  });

  it('set is idempotent — re-applying the same value does not re-persist', () => {
    stubGamut(true);
    const p = pref();
    p.set('srgb');
    const before = TypedStorage.get<string>(STORAGE_KEYS.CANVAS_COLOR_SPACE);
    p.set('srgb');
    expect(TypedStorage.get<string>(STORAGE_KEYS.CANVAS_COLOR_SPACE)).toBe(before);
  });
});

describe('isCanvasColorSpace', () => {
  it('accepts only the two known wire values', () => {
    expect(isCanvasColorSpace('display-p3')).toBe(true);
    expect(isCanvasColorSpace('srgb')).toBe(true);
    expect(isCanvasColorSpace('adobe-rgb')).toBe(false);
    expect(isCanvasColorSpace('')).toBe(false);
    expect(isCanvasColorSpace(null)).toBe(false);
    expect(isCanvasColorSpace(undefined)).toBe(false);
    expect(isCanvasColorSpace(1)).toBe(false);
  });
});
