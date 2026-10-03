/** HTTP input cannot attest original identity: provenance lives in a server checkpoint (#4111). */
import { ObjectId } from '../db/object-id.ts';
import { getJob } from '../job-runner/jobs.repo.ts';
import type { SqliteDb } from '../db/repos/db-handle.ts';
import { parseExportPayload } from './export-payload.ts';

export async function initialExportPayload(
  raw: Record<string, unknown>,
  requestId?: string,
  db?: SqliteDb,
) {
  const previous = requestId ? await getJob(new ObjectId(requestId), db) : null;
  const parsed = parseExportPayload({ ...raw, originalPaths: undefined });
  // Replays retain legacy payload equality, but never promote a legacy field to trusted provenance.
  const originalPaths = previous
    ? previous.payload['originalPaths']
    : [...new Set(parsed.targets.map((target) => target.path))];
  const payload = parseExportPayload({
    ...parsed,
    ...(originalPaths !== undefined ? { originalPaths } : {}),
  });
  const retained = previous ? previous.checkpoint?.['originalPaths'] : originalPaths;
  return {
    payload: { ...payload },
    ...(retained === undefined ? {} : { checkpoint: { originalPaths: retained } }),
  };
}
