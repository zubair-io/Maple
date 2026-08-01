import { parseAddress } from '../addressing/maple-address';
import { splitRelPath, validateRelPath } from '../addressing/fs-access-library-source';
import type { AssetId } from '../models/asset';

export interface PreviewLocation {
  dir: string;
  filename: string;
}

/** Resolve a safe Hosted cache location from an addressable asset id. */
export function previewLocation(id: AssetId): PreviewLocation | null {
  if (typeof id !== 'string') return null;
  if (!id.includes(':') || id.startsWith('fs:')) return null;
  try {
    const { relPath } = parseAddress(id);
    validateRelPath(relPath);
    const location = splitRelPath(relPath);
    return location.filename ? location : null;
  } catch {
    return null;
  }
}
