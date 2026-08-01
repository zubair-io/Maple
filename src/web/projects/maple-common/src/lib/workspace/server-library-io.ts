import { InjectionToken } from '@angular/core';
import type { Observable } from 'rxjs';
import type { DownloadProgress } from '../api/filesystem-browse.service';

export interface ApiFolder {
  id: string;
  path: string;
  slug?: string;
  label: string;
  last_scan: string | null;
  file_count: number;
  created_at: string;
}

export interface ApiHistogram {
  /** Unnormalised server-computed RGB bins; each channel has 256 entries. */
  r: number[];
  g: number[];
  b: number[];
}

export interface FolderRescanResult {
  ok: boolean;
  folderId: string;
  path: string;
  reset: number;
  error?: string;
}

export interface FolderScanResult {
  ok: boolean;
  folderId?: string;
  path?: string;
  skipped?: 'recent';
  last_scan?: string;
  error?: string;
}

/** Narrow server port consumed by shared library state. It deliberately owns
 * its DTOs instead of deriving its shape from the concrete Bun HTTP client. */
export interface ServerLibraryIo {
  listFolders(): Observable<ApiFolder[]>;
  registerFolder(folderPath: string): Observable<ApiFolder>;
  rescanFolder(folderId: string): Observable<FolderRescanResult>;
  scanFolder(folderId: string): Observable<FolderScanResult>;
  getThumb(assetId: string): Observable<Blob>;
  getRawBytes(
    assetId: string,
    onProgress?: (progress: DownloadProgress) => void,
  ): Observable<ArrayBuffer>;
  getHistogram(assetId: string): Observable<ApiHistogram>;
  getDisplayConfig(): Observable<{ show_hidden_images: boolean }>;
}

export const SERVER_LIBRARY_IO = new InjectionToken<ServerLibraryIo | null>('SERVER_LIBRARY_IO');
