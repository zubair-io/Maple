// BrowsePreferencesService — viewMode coverage (Map T3, #2827).
//
// Focused on the `'folder' | 'timeline' | 'map'` widening: the corrupted-
// storage guard on seed, and that `setViewMode('map')` persists like the
// existing two modes. See `typed-storage.spec.ts`'s header note on why
// `cm.*` keys need clearing around specs that construct the real service.

import { TestBed } from '@angular/core/testing';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { STORAGE_KEYS, TypedStorage } from '../util/typed-storage';
import { BrowsePreferencesService } from './browse-preferences.service';

function clearAllKeys(): void {
  for (const key of Object.values(STORAGE_KEYS)) localStorage.removeItem(key);
}

beforeEach(clearAllKeys);
afterEach(clearAllKeys);

describe('BrowsePreferencesService.viewMode', () => {
  it('defaults to folder with nothing persisted', () => {
    const service = TestBed.inject(BrowsePreferencesService);
    expect(service.viewMode()).toBe('folder');
  });

  it('seeds from a persisted "map" value', () => {
    TypedStorage.set(STORAGE_KEYS.VIEW_MODE, 'map');
    const service = TestBed.inject(BrowsePreferencesService);
    expect(service.viewMode()).toBe('map');
  });

  it('falls back to folder for a corrupted/unrecognized persisted value', () => {
    TypedStorage.set(STORAGE_KEYS.VIEW_MODE, 'bogus');
    const service = TestBed.inject(BrowsePreferencesService);
    expect(service.viewMode()).toBe('folder');
  });

  it('setViewMode("map") updates the signal and persists', () => {
    const service = TestBed.inject(BrowsePreferencesService);
    service.setViewMode('map');
    expect(service.viewMode()).toBe('map');
    expect(TypedStorage.get(STORAGE_KEYS.VIEW_MODE)).toBe('map');
  });
});
