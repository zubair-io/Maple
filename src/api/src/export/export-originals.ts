/** Retained original paths are authorized before any filesystem query (#4111). */
import { resolve } from 'node:path';
import { sqliteDb } from '../db/repos/db-handle.ts';
import { realpath } from '../fs/mirrored.ts';
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

async function loadServerExportOutputs(
  directory: string | null,
): Promise<ReadonlyMap<string, ReadonlySet<string>>> {
  const outputs = new Map<string, Set<string>>();
  if (!directory) return outputs;
  const resolvedDir = resolve(directory);
  const canonicalDir = (await realpath(resolvedDir).catch(() => null)) ?? resolvedDir;
  const resolvedNeedle = JSON.stringify(resolvedDir).slice(1, -1).toLowerCase();
  const canonicalNeedle = JSON.stringify(canonicalDir).slice(1, -1).toLowerCase();
  const rows = await sqliteDb().read<{ ledger: string }>(
    `SELECT ledger
       FROM jobs
      WHERE kind IN ('batch_recipe_export', 'batch_jpeg_export')
        AND ledger IS NOT NULL
        AND (instr(lower(ledger), ?) > 0 OR instr(lower(ledger), ?) > 0)`,
    [resolvedNeedle, canonicalNeedle],
  );
  for (const row of rows) {
    const parsed = JSON.parse(row.ledger) as Record<string, unknown> | null;
    const entries = parsed?.['entries'];
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
    serverOutputs: await loadServerExportOutputs(payload.recipe.directory),
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
