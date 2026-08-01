import { InjectionToken } from '@angular/core';
import type { BunApiBackendService } from '../api/bun-api-backend.service';

/** Self Hosted library operations that are still consumed by shared shells.
 * Keeping this type-only dependency prevents the Bun client from entering the
 * Hosted runtime graph. */
export type ServerLibraryIo = Pick<
  BunApiBackendService,
  | 'listFolders'
  | 'registerFolder'
  | 'rescanFolder'
  | 'scanFolder'
  | 'getThumb'
  | 'getRawBytes'
  | 'getHistogram'
  | 'getDisplayConfig'
>;

export const SERVER_LIBRARY_IO = new InjectionToken<ServerLibraryIo | null>('SERVER_LIBRARY_IO');
