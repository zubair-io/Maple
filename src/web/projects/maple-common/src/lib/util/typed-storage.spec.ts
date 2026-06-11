import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { TypedStorage, STORAGE_KEYS, type StorageKey } from './typed-storage';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function clearAllKeys(): void {
  for (const key of Object.values(STORAGE_KEYS)) localStorage.removeItem(key);
}

// Vitest workers reuse one jsdom — and therefore one `localStorage` — across
// spec files. Files that construct the real BrowsePreferencesService persist
// `cm.*` keys (its activeTab effect writes `cm.tab` even when only seeding the
// default), so the "absent key" assertions below are order-dependent unless
// every key is cleared up front. The afterEach keeps this file from leaking
// state into sibling files in turn (#1142).
beforeEach(clearAllKeys);
afterEach(clearAllKeys);

// ---------------------------------------------------------------------------
// STORAGE_KEYS
// ---------------------------------------------------------------------------

describe('STORAGE_KEYS', () => {
  it('contains all expected cm.* keys', () => {
    const values = Object.values(STORAGE_KEYS);
    expect(values.every((v) => v.startsWith('cm.'))).toBe(true);
  });

  it('has no duplicate values', () => {
    const values = Object.values(STORAGE_KEYS);
    const unique = new Set(values);
    expect(unique.size).toBe(values.length);
  });

  it('LAST_SOURCE key matches the legacy LAST_SOURCE_KEY literal', () => {
    // Regression: preserve backward compatibility with existing persisted data.
    expect(STORAGE_KEYS.LAST_SOURCE).toBe('cm.lastSourceId');
  });

  it('RECENT_QUERIES key matches the legacy RECENT_QUERIES_KEY literal', () => {
    expect(STORAGE_KEYS.RECENT_QUERIES).toBe('cm.search.recent');
  });
});

// ---------------------------------------------------------------------------
// TypedStorage.get / TypedStorage.set
// ---------------------------------------------------------------------------

describe('TypedStorage.get', () => {
  const KEY: StorageKey = STORAGE_KEYS.TAB;

  it('returns null for an absent key', () => {
    expect(TypedStorage.get(KEY)).toBeNull();
  });

  it('round-trips a string value', () => {
    TypedStorage.set(KEY, 'develop');
    expect(TypedStorage.get<string>(KEY)).toBe('develop');
  });

  it('round-trips a boolean value', () => {
    TypedStorage.set(STORAGE_KEYS.LEFT_HIDDEN, false);
    expect(TypedStorage.get<boolean>(STORAGE_KEYS.LEFT_HIDDEN)).toBe(false);
  });

  it('round-trips a number value', () => {
    TypedStorage.set(STORAGE_KEYS.THUMB_SIZE, 140);
    expect(TypedStorage.get<number>(STORAGE_KEYS.THUMB_SIZE)).toBe(140);
  });

  it('round-trips a plain object', () => {
    const sections = { folders: true, photos: false };
    TypedStorage.set(STORAGE_KEYS.SECTIONS, sections);
    expect(TypedStorage.get<Record<string, boolean>>(STORAGE_KEYS.SECTIONS)).toEqual(sections);
  });

  it('round-trips an array of strings', () => {
    const queries = ['sunset', 'mountains'];
    TypedStorage.set(STORAGE_KEYS.RECENT_QUERIES, queries);
    expect(TypedStorage.get<string[]>(STORAGE_KEYS.RECENT_QUERIES)).toEqual(queries);
  });

  it('returns null when the stored value is not valid JSON', () => {
    localStorage.setItem(KEY, 'not-json-{{{');
    expect(TypedStorage.get(KEY)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// TypedStorage.getRaw / TypedStorage.setRaw
// ---------------------------------------------------------------------------

describe('TypedStorage.getRaw', () => {
  const KEY = STORAGE_KEYS.THUMB_SIZE;

  it('returns null for an absent key', () => {
    expect(TypedStorage.getRaw(KEY)).toBeNull();
  });

  it('round-trips a raw string without JSON wrapping', () => {
    TypedStorage.setRaw(KEY, '160');
    expect(TypedStorage.getRaw(KEY)).toBe('160');
  });

  it('setRaw stores the exact string passed (no JSON.stringify)', () => {
    TypedStorage.setRaw(KEY, 'hello');
    // getRaw should not see quotes that JSON.stringify would add
    expect(TypedStorage.getRaw(KEY)).toBe('hello');
    // get (JSON.parse) would fail on a plain unquoted string; that's fine
    // because setRaw is for callers that manage their own encoding.
  });
});

// ---------------------------------------------------------------------------
// TypedStorage.remove
// ---------------------------------------------------------------------------

describe('TypedStorage.remove', () => {
  const KEY = STORAGE_KEYS.SORT;

  it('removes a key that was set', () => {
    TypedStorage.set(KEY, 'date');
    TypedStorage.remove(KEY);
    expect(TypedStorage.get(KEY)).toBeNull();
  });

  it('is a no-op for a key that was never set', () => {
    expect(() => TypedStorage.remove(KEY)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// SSR guard: when localStorage is unavailable
// ---------------------------------------------------------------------------

describe('TypedStorage SSR guard', () => {
  let originalWindow: typeof globalThis.window;

  beforeEach(() => {
    originalWindow = globalThis.window;
    // Simulate SSR by hiding `window`.
    Object.defineProperty(globalThis, 'window', {
      value: undefined,
      writable: true,
      configurable: true,
    });
  });

  afterEach(() => {
    Object.defineProperty(globalThis, 'window', {
      value: originalWindow,
      writable: true,
      configurable: true,
    });
  });

  it('get returns null when window is undefined', () => {
    expect(TypedStorage.get(STORAGE_KEYS.TAB)).toBeNull();
  });

  it('getRaw returns null when window is undefined', () => {
    expect(TypedStorage.getRaw(STORAGE_KEYS.LAST_SOURCE)).toBeNull();
  });

  it('set does not throw when window is undefined', () => {
    expect(() => TypedStorage.set(STORAGE_KEYS.TAB, 'develop')).not.toThrow();
  });

  it('setRaw does not throw when window is undefined', () => {
    expect(() => TypedStorage.setRaw(STORAGE_KEYS.THUMB_SIZE, '140')).not.toThrow();
  });

  it('remove does not throw when window is undefined', () => {
    expect(() => TypedStorage.remove(STORAGE_KEYS.TAB)).not.toThrow();
  });
});
