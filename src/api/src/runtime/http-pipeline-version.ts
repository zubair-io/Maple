import type { Context } from 'elysia';
import { PIPELINE_OUTPUT_VERSION } from '../generated/adjustment-fields.generated.ts';

export function incompatiblePipelineVersion(version: unknown, set: Context['set']) {
  if (version === undefined || version === String(PIPELINE_OUTPUT_VERSION)) return null;
  set.status = 409;
  return { error: 'Pipeline version does not match this server' };
}
