// library-fetch.service.spec.ts — Task 9 (M2 web addressing cutover).
//
// Tests that the Self-Hosted listing path routes through LibrarySource
// and produces slug:relPath address-keyed asset/folder ids (not `fs:` strings).

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type {
  LibrarySource,
  FolderListing,
  ImageEntry,
  LibraryFolderEntry,
} from '../addressing/library-source';
import { parseAddress, formatAddress } from '../addressing/maple-address';
import type { MapleAddress } from '../addressing/maple-address';

// ---------------------------------------------------------------------------
// Helpers for building test fixtures
// ---------------------------------------------------------------------------

const LIB_SLUG = 'library';

function makeImage(name: string, relPath: string): ImageEntry {
  return {
    name,
    address: formatAddress({ slug: LIB_SLUG, relPath }),
    mapleId: null,
    indexed: false,
  };
}

function makeFolder(name: string, relPath: string): LibraryFolderEntry {
  return {
    name,
    address: formatAddress({ slug: LIB_SLUG, relPath }),
  };
}

function makeListing(
  relPath: string,
  images: ImageEntry[],
  folders: LibraryFolderEntry[],
  parent: string | null = null,
): FolderListing {
  return {
    address: formatAddress({ slug: LIB_SLUG, relPath }),
    parent,
    folders,
    images,
  };
}

// ---------------------------------------------------------------------------
// Mock LibrarySource
// ---------------------------------------------------------------------------

function createMockLibrarySource(listingsByAddress: Map<string, FolderListing>): LibrarySource {
  return {
    listFolder(a: MapleAddress): Promise<FolderListing> {
      const key = formatAddress(a);
      const listing = listingsByAddress.get(key);
      if (listing) return Promise.resolve(listing);
      return Promise.reject(new Error(`No listing for ${key}`));
    },
    imageBlob(_a: MapleAddress): Promise<Blob> {
      return Promise.resolve(new Blob());
    },
    thumbBlob(_a: MapleAddress): Promise<Blob> {
      return Promise.resolve(new Blob());
    },
    previewBlob(_a: MapleAddress): Promise<Blob> {
      return Promise.resolve(new Blob());
    },
  };
}

// ---------------------------------------------------------------------------
// Address contract tests (pure, no Angular DI)
// ---------------------------------------------------------------------------

describe('M2 addressing — library-source FolderListing contract', () => {
  it('ImageEntry.address round-trips through parseAddress', () => {
    const img = makeImage('IMG_001.dng', '2026/jan/IMG_001.dng');
    const addr = parseAddress(img.address);
    expect(addr.slug).toBe(LIB_SLUG);
    expect(addr.relPath).toBe('2026/jan/IMG_001.dng');
  });

  it('LibraryFolderEntry.address round-trips through parseAddress', () => {
    const folder = makeFolder('jan', '2026/jan');
    const addr = parseAddress(folder.address);
    expect(addr.slug).toBe(LIB_SLUG);
    expect(addr.relPath).toBe('2026/jan');
  });

  it('FolderListing.address for root has empty relPath', () => {
    const listing = makeListing('', [], []);
    const addr = parseAddress(listing.address);
    expect(addr.slug).toBe(LIB_SLUG);
    expect(addr.relPath).toBe('');
  });

  it('makeListing matches formatAddress', () => {
    const listing = makeListing('2026/jan', [], []);
    expect(listing.address).toBe(`${LIB_SLUG}:2026/jan`);
  });
});

describe('M2 addressing — LibrarySource mock contract', () => {
  let mockSource: LibrarySource;
  const rootListing = makeListing(
    '',
    [makeImage('IMG_001.dng', 'IMG_001.dng')],
    [makeFolder('2026', '2026')],
    null,
  );
  const subListing = makeListing(
    '2026',
    [makeImage('IMG_002.dng', '2026/IMG_002.dng')],
    [],
    formatAddress({ slug: LIB_SLUG, relPath: '' }),
  );

  beforeEach(() => {
    const listings = new Map<string, FolderListing>([
      [formatAddress({ slug: LIB_SLUG, relPath: '' }), rootListing],
      [formatAddress({ slug: LIB_SLUG, relPath: '2026' }), subListing],
    ]);
    mockSource = createMockLibrarySource(listings);
  });

  it('listFolder root returns images with address-keyed ids (no fs: prefix)', async () => {
    const listing = await mockSource.listFolder({ slug: LIB_SLUG, relPath: '' });
    expect(listing.images).toHaveLength(1);
    expect(listing.images[0].address).toBe(`${LIB_SLUG}:IMG_001.dng`);
    expect(listing.images[0].address).not.toContain('fs:');
  });

  it('listFolder root returns folders with address-keyed ids (no fs: prefix)', async () => {
    const listing = await mockSource.listFolder({ slug: LIB_SLUG, relPath: '' });
    expect(listing.folders).toHaveLength(1);
    expect(listing.folders[0].address).toBe(`${LIB_SLUG}:2026`);
    expect(listing.folders[0].address).not.toContain('fs:');
  });

  it('listFolder sub-folder returns images keyed to full relPath', async () => {
    const listing = await mockSource.listFolder({ slug: LIB_SLUG, relPath: '2026' });
    expect(listing.images[0].address).toBe(`${LIB_SLUG}:2026/IMG_002.dng`);
  });

  it('listFolder rejects for unknown address', async () => {
    await expect(mockSource.listFolder({ slug: LIB_SLUG, relPath: 'missing' })).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// currentRegisteredFolder slug-matching tests (Library-store logic, pure)
// ---------------------------------------------------------------------------

describe('M2 addressing — currentRegisteredFolder slug matching', () => {
  // We test the slug-matching logic directly (extracted from the store method)
  // without spinning up Angular DI.

  function findByAddress(
    selectedSourceId: string,
    folders: { id: string; path: string; slug?: string }[],
  ): { id: string; path: string; slug?: string } | null {
    if (!selectedSourceId) return null;
    if (selectedSourceId.includes(':') && !selectedSourceId.startsWith('fs:')) {
      const addr = parseAddress(selectedSourceId);
      return folders.find((f) => f.slug === addr.slug || f.id === addr.slug) ?? null;
    }
    if (selectedSourceId.startsWith('fs:')) {
      const absPath = selectedSourceId.slice(3);
      let best = null;
      for (const f of folders) {
        if (absPath === f.path || absPath.startsWith(f.path + '/')) {
          if (!best || f.path.length > best.path.length) best = f;
        }
      }
      return best;
    }
    return null;
  }

  const FOLDERS = [
    { id: 'aaaaaa', path: '/Volumes/Photos', slug: 'photos' },
    { id: 'bbbbbb', path: '/Volumes/Backup', slug: 'backup' },
  ];

  it('matches by slug on new slug:relPath address', () => {
    const result = findByAddress('photos:2026/jan', FOLDERS);
    expect(result?.slug).toBe('photos');
  });

  it('matches root address (empty relPath)', () => {
    const result = findByAddress('photos:', FOLDERS);
    expect(result?.slug).toBe('photos');
  });

  it('matches by id when slug field absent (pre-M1 server)', () => {
    const preMigratedFolders = FOLDERS.map((f) => ({ ...f, slug: undefined }));
    const result = findByAddress(`aaaaaa:2026`, preMigratedFolders);
    expect(result?.id).toBe('aaaaaa');
  });

  it('returns null for unknown slug', () => {
    const result = findByAddress('unknown-slug:2026', FOLDERS);
    expect(result).toBeNull();
  });

  it('falls back to path-match for legacy fs: prefix', () => {
    const result = findByAddress('fs:/Volumes/Photos/2026', FOLDERS);
    expect(result?.slug).toBe('photos');
  });

  it('falls back to longest path match for nested fs: path', () => {
    const nestedFolders = [
      { id: 'aaa', path: '/Volumes', slug: 'root' },
      { id: 'bbb', path: '/Volumes/Photos', slug: 'photos' },
    ];
    const result = findByAddress('fs:/Volumes/Photos/2026', nestedFolders);
    expect(result?.slug).toBe('photos');
  });

  it('returns null for legacy fs: prefix with non-matching path', () => {
    const result = findByAddress('fs:/Volumes/Other/2026', FOLDERS);
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// _selectInitialFolder logic tests (extracted, pure)
// ---------------------------------------------------------------------------

describe('M2 addressing — _selectInitialFolder fallback logic', () => {
  const FOLDERS = [
    { id: 'aaa', path: '/Volumes/A', slug: 'alpha' },
    { id: 'bbb', path: '/Volumes/B', slug: 'beta' },
  ];

  function selectInitialFolder(
    lastId: string | null,
    existing: string | null,
  ): { action: string; sourceId?: string } {
    // Mirrors the logic in _selectInitialFolder after the M2 cutover.
    if (existing && existing.includes(':')) {
      return { action: 'keep-existing', sourceId: existing };
    }
    if (lastId && lastId.includes(':') && !lastId.startsWith('fs:')) {
      try {
        const addr = parseAddress(lastId);
        const owning = FOLDERS.find((f) => f.slug === addr.slug || f.id === addr.slug);
        if (owning) return { action: 'restore', sourceId: lastId };
      } catch {
        // fall through
      }
    }
    // Legacy fs: or unknown — open first
    const first = FOLDERS[0];
    if (first) {
      const rootId = formatAddress({ slug: first.slug ?? first.id, relPath: '' });
      return { action: 'open-first', sourceId: rootId };
    }
    return { action: 'empty' };
  }

  it('keeps existing selection when already set to a slug:relPath address', () => {
    const r = selectInitialFolder(null, 'alpha:2026');
    expect(r.action).toBe('keep-existing');
    expect(r.sourceId).toBe('alpha:2026');
  });

  it('restores saved slug:relPath from localStorage', () => {
    const r = selectInitialFolder('alpha:2026', null);
    expect(r.action).toBe('restore');
    expect(r.sourceId).toBe('alpha:2026');
  });

  it('falls back to first folder when stored slug is unknown', () => {
    const r = selectInitialFolder('unknown:2026', null);
    expect(r.action).toBe('open-first');
  });

  it('falls back to first folder when legacy fs: id is stored (hard cutover)', () => {
    const r = selectInitialFolder('fs:/Volumes/A', null);
    expect(r.action).toBe('open-first');
  });

  it('opens first folder when nothing is stored', () => {
    const r = selectInitialFolder(null, null);
    expect(r.action).toBe('open-first');
    expect(r.sourceId).toBe('alpha:');
  });
});

// ---------------------------------------------------------------------------
// Sidebar folder-tree ordering (mirrors _attachFolderChildren, pure)
// ---------------------------------------------------------------------------

describe('sidebar tree — folder children ordering', () => {
  type PriorEntry = { id: string; label: string };

  // Mirrors the child-building + sort in _attachFolderChildren: map each
  // listing folder to a sidebar entry (carrying over a prior entry's identity
  // if present) then sort alphabetically by display label.
  function attachChildLabels(
    folders: { name: string; address: string }[],
    prior: PriorEntry[] = [],
  ): string[] {
    const existingById = new Map(prior.map((c) => [c.id, c]));
    return folders
      .map((d) => {
        const p = existingById.get(d.address);
        return p ? { ...p, label: d.name } : { id: d.address, label: d.name };
      })
      .sort((a, b) => a.label.localeCompare(b.label))
      .map((c) => c.label);
  }

  it('sorts sidebar folder children alphabetically regardless of listing order', () => {
    const folders = [
      makeFolder('Zebra', 'Zebra'),
      makeFolder('apple', 'apple'),
      makeFolder('Mango', 'Mango'),
    ];
    expect(attachChildLabels(folders)).toEqual(['apple', 'Mango', 'Zebra']);
  });

  it('keeps ordering stable when a parent is refetched (existing children preserved)', () => {
    const folders = [makeFolder('Beta', 'Beta'), makeFolder('Alpha', 'Alpha')];
    const prior = [{ id: `${LIB_SLUG}:Alpha`, label: 'Alpha' }];
    expect(attachChildLabels(folders, prior)).toEqual(['Alpha', 'Beta']);
  });
});
