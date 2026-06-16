// FsAccessLibrarySource — pure logic tests.
//
// Tests the path-walking and traversal-rejection logic without real FS-Access
// handles (not available in jsdom). The injectable class uses LibrarySlugRegistry
// and a MapleCache service (tested separately); here we focus on:
//   - listFolder produces correct FolderListing with indexed:true, mapleId:null
//   - traversal segments (..) are rejected
//   - childAddress logic for building image addresses

import { describe, it, expect } from 'vitest';
import {
  validateRelPath,
  buildFolderListing,
  type FsEntry,
} from './fs-access-library-source';
import type { MapleAddress } from './maple-address';

describe('validateRelPath', () => {
  it('allows empty relPath (root)', () => {
    expect(() => validateRelPath('')).not.toThrow();
  });

  it('allows a normal nested path', () => {
    expect(() => validateRelPath('2026/France/0002')).not.toThrow();
  });

  it('rejects .. traversal', () => {
    expect(() => validateRelPath('../etc/passwd')).toThrow('traversal');
  });

  it('rejects .. in middle of path', () => {
    expect(() => validateRelPath('2026/../secret')).toThrow('traversal');
  });

  it('rejects absolute paths', () => {
    expect(() => validateRelPath('/abs/path')).toThrow('absolute');
  });

  it('rejects backslash (Windows path separator)', () => {
    expect(() => validateRelPath('folder\\file')).toThrow('backslash');
  });
});

describe('buildFolderListing', () => {
  const addr: MapleAddress = { slug: 'lib', relPath: '2026/France' };

  const entries: FsEntry[] = [
    { kind: 'directory', name: '0001' },
    { kind: 'directory', name: '0002' },
    { kind: 'file', name: 'IMG_001.JPG' },
    { kind: 'file', name: 'IMG_002.ARW' },
    { kind: 'file', name: 'thumbs.db' }, // non-RAW, still listed
    { kind: 'file', name: '.DS_Store' }, // hidden, filtered out
  ];

  it('produces correct FolderListing shape', () => {
    const listing = buildFolderListing(addr, entries, null);
    expect(listing.address).toBe('lib:2026/France');
    expect(listing.parent).toBe('lib:2026');
  });

  it('maps directories to folders with correct addresses', () => {
    const { folders } = buildFolderListing(addr, entries, null);
    expect(folders).toHaveLength(2);
    expect(folders[0]).toEqual({ name: '0001', address: 'lib:2026/France/0001' });
    expect(folders[1]).toEqual({ name: '0002', address: 'lib:2026/France/0002' });
  });

  it('maps files to images with indexed:true and mapleId:null (per spec)', () => {
    const { images } = buildFolderListing(addr, entries, null);
    // Filters out dot-files; includes all others
    const nonHidden = entries.filter((e) => e.kind === 'file' && !e.name.startsWith('.'));
    expect(images).toHaveLength(nonHidden.length);
    for (const img of images) {
      expect(img.indexed).toBe(true);
      expect(img.mapleId).toBeNull();
    }
  });

  it('image addresses use childAddress correctly', () => {
    const { images } = buildFolderListing(addr, entries, null);
    const jpg = images.find((i) => i.name === 'IMG_001.JPG');
    expect(jpg?.address).toBe('lib:2026/France/IMG_001.JPG');
  });

  it('parent is null at the library root', () => {
    const rootAddr: MapleAddress = { slug: 'lib', relPath: '' };
    const listing = buildFolderListing(rootAddr, [], null);
    expect(listing.parent).toBeNull();
  });
});
