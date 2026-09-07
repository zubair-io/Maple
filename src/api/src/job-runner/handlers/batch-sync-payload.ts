import { extname, isAbsolute, resolve } from 'node:path';
import { CURRENT_WHITE_BALANCE_SCALE_VERSION } from '../../generated/adjustment-transfer.generated.ts';
import { xmpSidecarPath } from '../../fs/xmp.ts';
import { isVideoFilename } from '../../indexer/media-types.ts';
import {
  applyTransferPatch,
  parseTransferPatch,
  type XmpTransferPatch,
} from '../../xmp/transfer-patch.ts';
import { parseWhiteBalanceCorrection, type WhiteBalanceCorrection } from './batch-white-balance.ts';

export interface SyncTarget {
  id: string;
  path: string;
  patch?: XmpTransferPatch;
}
export interface SyncPayload {
  targets: SyncTarget[];
  patch: XmpTransferPatch;
  relativeWhiteBalance?: WhiteBalanceCorrection;
}
function parsePhotoId(id: unknown): string {
  if (typeof id !== 'string' || !id.length || id.length > 2048 || id.includes('\0'))
    throw new Error('Every photo needs an id and an absolute path');
  return id;
}

function parsePhotoPath(path: unknown): string {
  if (typeof path !== 'string' || path.length > 8192 || !isAbsolute(path) || path.includes('\0'))
    throw new Error('Every photo needs an id and an absolute path');
  if (isVideoFilename(path) || extname(path).toLowerCase() === '.xmp')
    throw new Error('Sync settings requires photos');
  return path;
}

function parseTarget(value: unknown): SyncTarget {
  if (!value || typeof value !== 'object')
    throw new Error('Every photo needs an id and an absolute path');
  const photo = value as Record<string, unknown>;
  const id = parsePhotoId(photo['id']);
  const path = parsePhotoPath(photo['path']);
  const patch = photo['patch'] === undefined ? undefined : parseTransferPatch(photo['patch']);
  if (patch) applyTransferPatch('', patch);
  return { id, path, ...(patch ? { patch } : {}) };
}

export function parseSyncPayload(raw: Record<string, unknown>): SyncPayload {
  const values = raw['targets'];
  if (!Array.isArray(values) || values.length < 1 || values.length > 2000)
    throw new Error('Choose 1–2,000 photos');
  const targets = values.map(parseTarget);
  if (
    new Set(targets.map((t) => t.id)).size !== targets.length ||
    new Set(targets.map((t) => resolve(xmpSidecarPath(t.path)))).size !== targets.length
  )
    throw new Error('Photos in this batch share a sidecar');
  const patch = parseTransferPatch(raw['patch']);
  applyTransferPatch('', patch); // Reject malformed patch XML before queueing any writes.
  const relativeWhiteBalance = parseWhiteBalanceCorrection(raw['relativeWhiteBalance']);
  if (relativeWhiteBalance && !Object.hasOwn(patch.attributes, 'crs:WhiteBalance'))
    throw new Error('Relative white balance requires the white balance group');
  if (
    relativeWhiteBalance &&
    patch.attributes['papp:WbScaleVersion'] !== String(CURRENT_WHITE_BALANCE_SCALE_VERSION)
  )
    throw new Error(
      'Relative white balance requires a current-scale source. Reapply its white balance first.',
    );
  return { targets, patch, relativeWhiteBalance };
}
