// LibrarySource — strategy interface for accessing library contents.
//
// Two implementations:
//   - HttpLibrarySource (Self-Hosted): calls the M1 API routes.
//   - FsAccessLibrarySource (Hosted): walks FileSystemDirectoryHandles locally.
//
// Consumers inject LIBRARY_SOURCE and call the interface; the concrete impl
// is provided at the app level based on the backend flag.

import { InjectionToken } from '@angular/core';
import type { MapleAddress } from './maple-address';

export interface FolderEntry {
  name: string;
  address: string;
}

export interface ImageEntry {
  name: string;
  address: string;
  mapleId: string | null;
  indexed: boolean;
  width?: number;
  height?: number;
  capturedAt?: string;
}

export interface FolderListing {
  address: string;
  parent: string | null;
  folders: FolderEntry[];
  images: ImageEntry[];
}

export interface LibrarySource {
  listFolder(a: MapleAddress): Promise<FolderListing>;
  imageBlob(a: MapleAddress): Promise<Blob>;
  /**
   * Resolve the thumbnail URL for an image address.
   * Self-Hosted: returns an HTTP URL (immutable-cached, plain <img src>).
   * Hosted: returns a blob: URL backed by the local thumb cache.
   */
  thumbUrl(a: MapleAddress): Promise<string>;
  previewUrl(a: MapleAddress): Promise<string>;
}

export const LIBRARY_SOURCE = new InjectionToken<LibrarySource>('LIBRARY_SOURCE');
