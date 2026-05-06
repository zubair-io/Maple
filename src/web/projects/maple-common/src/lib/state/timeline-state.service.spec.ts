// TimelineStateService — unit tests covering pathPrefix derivation,
// trailing-slash normalisation, params composition, and the imperative
// filter setters.

import { TestBed } from '@angular/core/testing';
import { describe, it, expect, beforeEach } from 'vitest';

import { TimelineStateService } from './timeline-state.service';
import { LibraryStateService } from './library-state.service';
import { LIBRARY_BACKEND } from '../api/library-backend.token';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';

describe('TimelineStateService', () => {
  let timeline: TimelineStateService;
  let library: LibraryStateService;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: LIBRARY_BACKEND, useValue: 'self-hosted' },
      ],
    });
    timeline = TestBed.inject(TimelineStateService);
    library = TestBed.inject(LibraryStateService);
    library.sidebarTree.set([
      {
        kind: 'folder',
        id: 'fs:/Lib',
        label: 'Lib',
        count: null,
        absPath: '/Lib',
        children: [
          {
            kind: 'folder',
            id: 'fs:/Lib/2026',
            label: '2026',
            count: null,
            absPath: '/Lib/2026',
          },
          {
            // Sibling that shares the leading prefix — used to verify the
            // trailing-slash normalisation prevents accidental matches.
            kind: 'folder',
            id: 'fs:/Lib/2026-archive',
            label: '2026-archive',
            count: null,
            absPath: '/Lib/2026-archive',
          },
          {
            // Already has trailing slash — must not double-up.
            kind: 'folder',
            id: 'fs:/Lib/with-slash/',
            label: 'with-slash',
            count: null,
            absPath: '/Lib/with-slash/',
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

    it('appends a trailing slash when missing', () => {
      library.selectedSourceId.set('fs:/Lib/2026');
      expect(timeline.pathPrefix()).toBe('/Lib/2026/');
    });

    it('does not double up existing trailing slashes', () => {
      library.selectedSourceId.set('fs:/Lib/with-slash/');
      expect(timeline.pathPrefix()).toBe('/Lib/with-slash/');
    });

    it('walks recursively into children', () => {
      library.selectedSourceId.set('fs:/Lib/2026-archive');
      expect(timeline.pathPrefix()).toBe('/Lib/2026-archive/');
    });

    it('keeps `/Lib/2026` from matching `/Lib/2026-archive` paths via trailing slash', () => {
      library.selectedSourceId.set('fs:/Lib/2026');
      // The trailing-slash normalisation is the load-bearing guard.
      // /Lib/2026/photo.dng matches `^/Lib/2026/` — /Lib/2026-archive/photo.dng does not.
      expect(timeline.pathPrefix()).toBe('/Lib/2026/');
      expect('/Lib/2026/photo.dng'.startsWith(timeline.pathPrefix()!)).toBe(true);
      expect('/Lib/2026-archive/photo.dng'.startsWith(timeline.pathPrefix()!)).toBe(false);
    });
  });

  describe('params', () => {
    beforeEach(() => {
      library.selectedSourceId.set('fs:/Lib/2026');
    });

    it('returns null when no path scope is selected', () => {
      library.selectedSourceId.set('');
      expect(timeline.params()).toBeNull();
    });

    it('always sends hasCapturedAt:true and the resolved pathPrefix', () => {
      const p = timeline.params();
      expect(p).not.toBeNull();
      expect(p!.pathPrefix).toBe('/Lib/2026/');
      expect(p!.hasCapturedAt).toBe(true);
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
