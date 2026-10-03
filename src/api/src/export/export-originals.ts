/** Retained original paths are authorized before any filesystem query (#4111). */
import { resolve } from 'node:path';
import { realpath } from '../fs/mirrored.ts';
import { resolveAndAuthorizePath } from '../routes/xmp-path-auth.ts';
import { parseExportPayload, type ExportPayload } from './export-payload.ts';

export interface ExportOriginals {
  paths: ReadonlySet<string>;
  complete: boolean;
}
export async function exportOriginals(
  payload: ExportPayload,
  checkpoint?: Record<string, unknown>,
): Promise<ExportOriginals> {
  const paths = new Set<string>();
  const trusted = checkpoint?.['originalPaths'];
  // Old HTTP jobs persisted unknown payload fields; only server checkpoints attest the full set.
  const validated =
    trusted === undefined
      ? undefined
      : parseExportPayload({ ...payload, originalPaths: trusted }).originalPaths;
  const originals = validated ?? payload.targets.map((target) => target.path);
  for (const path of originals) {
    const allowed = await resolveAndAuthorizePath(path);
    if (!allowed.ok) throw new Error(allowed.error);
    paths.add(resolve(path));
    paths.add(resolve(allowed.data));
    const canonical = await realpath(allowed.data).catch((error) => {
      if ((error as NodeJS.ErrnoException | null | undefined)?.code === 'ENOENT') return null;
      throw error;
    });
    if (canonical) paths.add(canonical);
  }
  return { paths, complete: validated !== undefined };
}
