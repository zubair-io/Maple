/** Retained original paths are authorized before any filesystem query (#4111). */
import { resolve } from 'node:path';
import { realpath } from '../fs/mirrored.ts';
import { listJobs } from '../job-runner/jobs.repo.ts';
import { resolveAndAuthorizePath } from '../routes/xmp-path-auth.ts';
import { parseExportPayload, type ExportPayload } from './export-payload.ts';

export interface ExportOriginals {
  paths: ReadonlySet<string>;
  complete: boolean;
  serverOutputs: ReadonlyMap<string, ReadonlySet<string>>;
}

function recordEntryDigest(
  outputs: Map<string, Set<string>>,
  entry: Record<string, unknown>,
): void {
  const status = entry['status'];
  const outputPath = entry['outputPath'];
  const afterHash = entry['afterHash'];
  if (
    (status !== 'applied' && status !== 'prepared') ||
    typeof outputPath !== 'string' ||
    typeof afterHash !== 'string'
  )
    return;
  const key = resolve(outputPath).toLowerCase();
  let hashes = outputs.get(key);
  if (!hashes) {
    hashes = new Set<string>();
    outputs.set(key, hashes);
  }
  hashes.add(afterHash);
}

async function loadServerExportOutputs(): Promise<ReadonlyMap<string, ReadonlySet<string>>> {
  const [recipeJobs, jpegJobs] = await Promise.all([
    listJobs({ kind: 'batch_recipe_export', limit: 200 }),
    listJobs({ kind: 'batch_jpeg_export', limit: 200 }),
  ]);
  const outputs = new Map<string, Set<string>>();
  for (const job of [...recipeJobs, ...jpegJobs]) {
    const entries = job.checkpoint?.['entries'];
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      if (entry && typeof entry === 'object')
        recordEntryDigest(outputs, entry as Record<string, unknown>);
    }
  }
  return outputs;
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
  return {
    paths,
    complete: validated !== undefined,
    serverOutputs: await loadServerExportOutputs(),
  };
}

export function isPriorServerExport(
  originalPaths: ExportOriginals,
  resolvedOutput: string,
  canonicalOutput: string | null,
  currentHash: string | null,
): boolean {
  if (!currentHash) return false;
  const byResolved = originalPaths.serverOutputs.get(resolvedOutput.toLowerCase());
  if (byResolved?.has(currentHash)) return true;
  if (!canonicalOutput) return false;
  return originalPaths.serverOutputs.get(canonicalOutput.toLowerCase())?.has(currentHash) ?? false;
}
