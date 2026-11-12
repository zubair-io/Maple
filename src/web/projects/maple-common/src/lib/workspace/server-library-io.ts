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
  /**
   * Whether the root is currently reachable on the server (#2892). Absent on
   * pre-upgrade servers — treat missing as connected.
   */
  connected?: boolean;
}

/** `GET/PUT /api/display/config`; a PUT carries only the fields it changes. */
export interface ApiDisplayConfig {
  show_hidden_images: boolean;
  /** The user's RAW+JPEG stacking preference (#5050): stack-aware clients send
   * `stack=1` when it is on. Older servers omit it; treat that as on. */
  stack_raw_jpeg?: boolean;
}

export interface ApiHistogram {
  /** Unnormalised server-computed RGB bins; each channel has 256 entries. */
  r: number[];
  g: number[];
  b: number[];
}

/** Narrow server port consumed by shared library state. It deliberately owns
 * its DTOs instead of deriving its shape from the concrete Bun HTTP client. */
export interface ServerLibraryIo {
  listFolders(): Observable<ApiFolder[]>;
  registerFolder(folderPath: string): Observable<ApiFolder>;
  getThumb(assetId: string): Observable<Blob>;
  getRawBytes(
    assetId: string,
    onProgress?: (progress: DownloadProgress) => void,
  ): Observable<ArrayBuffer>;
  getHistogram(assetId: string): Observable<ApiHistogram>;
  getDisplayConfig(): Observable<ApiDisplayConfig>;
}

export const SERVER_LIBRARY_IO = new InjectionToken<ServerLibraryIo | null>('SERVER_LIBRARY_IO');
