// TimelineStateService — unit tests covering pathPrefix derivation,
// trailing-slash normalisation, params composition, and the imperative
// filter setters.

import { TestBed } from '@angular/core/testing';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { TimelineStateService } from './timeline-state.service';
import { LibraryStateService } from './library-state.service';
import { LIBRARY_BACKEND } from '../api/library-backend.token';
import { API_BASE_URL } from '../api/api-base-url.token';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { STORAGE_KEYS } from '../util/typed-storage';
import { provideSelfHostedWorkspace } from '../workspace/self-hosted-workspace.providers';

// This spec constructs the real BrowsePreferencesService (via
// TimelineStateService → LibraryStateService); its persistence effects write
// `cm.*` keys into the jsdom localStorage that vitest shares across spec
// files on a worker. Clear them around each test so nothing leaks into
// sibling spec files (#1142).
const clearPrefKeys = (): void => {
  for (const key of Object.values(STORAGE_KEYS)) localStorage.removeItem(key);
};
beforeEach(clearPrefKeys);
afterEach(clearPrefKeys);

describe('TimelineStateService', () => {
  let timeline: TimelineStateService;
  let library: LibraryStateService;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideSelfHostedWorkspace(),
        { provide: API_BASE_URL, useValue: '/api' },
        { provide: LIBRARY_BACKEND, useValue: 'self-hosted' },
      ],
    });
    timeline = TestBed.inject(TimelineStateService);
    library = TestBed.inject(LibraryStateService);
    // The Timeline scopes its server query to the registered library that
    // owns the selection, matched by the selected node's `slug:relPath`
    // address (the canonical post-M2 addressing scheme — plain `fs:<absPath>`
    // ids are the retired pre-M2 form). Lazy-loaded subfolder nodes don't
    // carry their own `absPath` in production, so this fixture deliberately
    // omits it on everything but the library root to match reality.
    library.registeredFolders.set([
      {
        id: 'lib-1',
        slug: 'lib',
        path: '/Lib',
        label: 'Lib',
        last_scan: null,
        file_count: 0,
        created_at: '2026-01-01T00:00:00.000Z',
      },
    ]);
    library.sidebarTree.set([
      {
        kind: 'folder',
        id: 'lib:',
        label: 'Lib',
        count: null,
        absPath: '/Lib',
        children: [
          {
            kind: 'folder',
            id: 'lib:2026',
            label: '2026',
            count: null,
          },
          {
            // Sibling that shares the leading prefix — used to verify the
            // trailing-slash normalisation prevents accidental matches.
            kind: 'folder',
            id: 'lib:2026-archive',
            label: '2026-archive',
            count: null,
          },
          {
            // relPath already carries a trailing slash — must not double-up.
            kind: 'folder',
            id: 'lib:with-slash/',
            label: 'with-slash',
            count: null,
          },
        ],
      },
      {
        // A non-fs entry — pathPrefix must return null when one is selected.
        kind: 'section',
        id: 'sec-photos',
        label: 'Photos',
        count: null,
      },
    ]);
  });

  describe('pathPrefix', () => {
    it('returns null when nothing is selected', () => {
      library.selectedSourceId.set('');
      expect(timeline.pathPrefix()).toBeNull();
    });

    it('returns null when a non-fs node is selected', () => {
      library.selectedSourceId.set('sec-photos');
      expect(timeline.pathPrefix()).toBeNull();
    });

    it('resolves the library root itself', () => {
      library.selectedSourceId.set('lib:');
      expect(timeline.pathPrefix()).toBe('/Lib/');
    });

    it('appends a trailing slash when missing', () => {
      library.selectedSourceId.set('lib:2026');
      expect(timeline.pathPrefix()).toBe('/Lib/2026/');
    });

    it('does not double up existing trailing slashes', () => {
      library.selectedSourceId.set('lib:with-slash/');
      expect(timeline.pathPrefix()).toBe('/Lib/with-slash/');
    });

    it('walks recursively into children', () => {
      library.selectedSourceId.set('lib:2026-archive');
      expect(timeline.pathPrefix()).toBe('/Lib/2026-archive/');
    });

    it('keeps `/Lib/2026` from matching `/Lib/2026-archive` paths via trailing slash', () => {
      library.selectedSourceId.set('lib:2026');
      // The trailing-slash normalisation is the load-bearing guard.
      // /Lib/2026/photo.dng matches `^/Lib/2026/` — /Lib/2026-archive/photo.dng does not.
      expect(timeline.pathPrefix()).toBe('/Lib/2026/');
      expect('/Lib/2026/photo.dng'.startsWith(timeline.pathPrefix()!)).toBe(true);
      expect('/Lib/2026-archive/photo.dng'.startsWith(timeline.pathPrefix()!)).toBe(false);
    });

    it('resolves against a pre-M1 library that has no slug, via id fallback', () => {
      library.registeredFolders.set([
        {
          id: 'lib',
          path: '/Lib',
          label: 'Lib',
          last_scan: null,
          file_count: 0,
          created_at: '2026-01-01T00:00:00.000Z',
        },
      ]);
      library.selectedSourceId.set('lib:2026');
      expect(timeline.pathPrefix()).toBe('/Lib/2026/');
    });
  });

  describe('params', () => {
    beforeEach(() => {
      library.selectedSourceId.set('lib:2026');
    });

    it('returns null when no path scope is selected', () => {
      library.selectedSourceId.set('');
      expect(timeline.params()).toBeNull();
    });

    it('sends hasCapturedAt:true, the library-relative pathPrefix, and libraryId', () => {
      const p = timeline.params();
      expect(p).not.toBeNull();
      // Relative to the owning library root `/Lib` — the server anchors this
      // against `fileinfo.path`, which is the directory relative to the root.
      expect(p!.pathPrefix).toBe('2026');
      expect(p!.libraryId).toBe('lib-1');
      expect(p!.hasCapturedAt).toBe(true);
    });

    it('omits pathPrefix but keeps libraryId when the library root itself is selected', () => {
      library.selectedSourceId.set('lib:');
      const p = timeline.params();
      expect(p).not.toBeNull();
      expect(p!.pathPrefix).toBeUndefined();
      expect(p!.libraryId).toBe('lib-1');
    });

    it('returns null when the owning library has not loaded yet', () => {
      library.registeredFolders.set([]);
      expect(timeline.params()).toBeNull();
    });

    it('threads the toolbar searchQuery through as q', () => {
      library.searchQuery.set('  sunset  ');
      expect(timeline.params()!.q).toBe('sunset');
    });

    it('omits q when the toolbar query is empty/whitespace', () => {
      library.searchQuery.set('   ');
      expect(timeline.params()!.q).toBeUndefined();
    });

    it('omits rating when minRating is 0', () => {
      timeline.setMinRating(0);
      expect(timeline.params()!.rating).toBeUndefined();
    });

    it('forwards minRating > 0 as rating', () => {
      timeline.setMinRating(4);
      expect(timeline.params()!.rating).toBe(4);
    });

    it('omits flag when set to ""', () => {
      timeline.setFlag('');
      expect(timeline.params()!.flag).toBeUndefined();
    });

    it('forwards flag values verbatim', () => {
      timeline.setFlag('pick');
      expect(timeline.params()!.flag).toBe('pick');
    });

    it('omits empty from/to/color and forwards non-empty ones', () => {
      timeline.setColor('red');
      timeline.setFrom('2025-01-01');
      timeline.setTo('');
      const p = timeline.params()!;
      expect(p.color).toBe('red');
      expect(p.from).toBe('2025-01-01');
      expect(p.to).toBeUndefined();
    });
  });

  describe('clearAll', () => {
    it('resets every filter signal to its default', () => {
      timeline.setMinRating(3);
      timeline.setFlag('reject');
      timeline.setColor('blue');
      timeline.setFrom('2025-01-01');
      timeline.setTo('2025-12-31');
      timeline.clearAll();
      expect(timeline.minRating()).toBe(0);
      expect(timeline.flag()).toBe('');
      expect(timeline.color()).toBe('');
      expect(timeline.from()).toBe('');
      expect(timeline.to()).toBe('');
    });
  });
});
