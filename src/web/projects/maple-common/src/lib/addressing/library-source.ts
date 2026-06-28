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
import type { DownloadProgress } from '../api/filesystem-browse.service';

/** A sub-folder entry returned by `LibrarySource.listFolder`. */
export interface LibraryFolderEntry {
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
  /** True when the asset is a video container. Used for grid badge. */
  isVideo?: boolean;
}

export interface FolderListing {
  address: string;
  parent: string | null;
  folders: LibraryFolderEntry[];
  images: ImageEntry[];
}

export interface LibrarySource {
  listFolder(a: MapleAddress): Promise<FolderListing>;
  /**
   * Fetch an image's original bytes as a Blob. Pass `onProgress` to receive
   * download-progress frames as the body streams in — HttpLibrarySource wires
   * them to the editor's open-progress overlay so a slow Self-Hosted fetch of a
   * 100MP RAW doesn't look hung. FsAccessLibrarySource reads a local file
   * handle (effectively instant) and ignores the callback.
   */
  imageBlob(a: MapleAddress, onProgress?: (p: DownloadProgress) => void): Promise<Blob>;
  /**
   * Fetch the thumbnail/preview JPEG for an image address as a Blob. The
   * CALLER owns the object-URL lifecycle (create + revoke) — see
   * LibraryCache.ThumbLruCache. Returning a Blob (not a blob: URL string)
   * keeps revocation explicit and lets Self-Hosted fetch via HttpClient so the
   * bearer token is attached (the /api/thumb|preview routes are bearer-only;
   * a bare <img src> would 401).
   */
  thumbBlob(a: MapleAddress): Promise<Blob | null>;
  previewBlob(a: MapleAddress): Promise<Blob | null>;
}

export const LIBRARY_SOURCE = new InjectionToken<LibrarySource>('LIBRARY_SOURCE');
