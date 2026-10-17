import type { Context } from 'elysia';
import { PIPELINE_OUTPUT_VERSION } from '../generated/adjustment-fields.generated.ts';

export function incompatiblePipelineVersion(version: unknown, set: Context['set']) {
  if (version === undefined || version === String(PIPELINE_OUTPUT_VERSION)) return null;
  set.status = 409;
  return { error: 'Pipeline version does not match this server' };
}

// Shipped apps lag the server by one or more pipeline bumps; an older client
// is served the current derivative (its version-keyed caches miss again after
// it upgrades). Only a client NEWER than this server is refused, because it
// would file this server's older pixels under its newer cache key.
export function unservablePipelineVersion(version: unknown, set: Context['set']) {
  if (version === undefined) return null;
  const requested = typeof version === 'string' && /^\d+$/.test(version) ? Number(version) : NaN;
  if (requested <= PIPELINE_OUTPUT_VERSION) return null;
  set.status = 409;
  return { error: 'Pipeline version is newer than this server' };
}
