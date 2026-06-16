// Pure selector for testing: maps backend kind to a string key.
// This file has NO Angular imports so it can be used in vitest directly.
import type { LibraryBackendKind } from '../api/library-backend.token';

export type LibrarySourceKey = 'http' | 'fs-access';

/**
 * Map a backend kind to a source key.
 * 'self-hosted' → 'http' (HttpLibrarySource)
 * 'hosted'      → 'fs-access' (FsAccessLibrarySource)
 */
export function selectLibrarySourceKey(backend: LibraryBackendKind): LibrarySourceKey {
  return backend === 'self-hosted' ? 'http' : 'fs-access';
}
