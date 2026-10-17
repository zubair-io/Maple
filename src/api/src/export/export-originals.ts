/** Retained original paths are authorized before any filesystem query (#4111). */
import { basename, dirname, extname, join, resolve } from 'node:path';
import { ObjectId } from '../db/object-id.ts';
import { hasLiveAssetAtAddress } from '../db/repos/assets.address.ts';
import { sqliteDb } from '../db/repos/db-handle.ts';
import { lstat, readdir, realpath } from '../fs/mirrored.ts';
import { mostSpecificRoot } from '../fs/root-match.ts';
import { loadLibraryRoots } from '../indexer/libraries.cache.ts';
import { resolveAndAuthorizePath } from '../routes/xmp-path-auth.ts';
import { parseExportPayload, type ExportPayload } from './export-payload.ts';

export interface ExportOriginals {
  paths: ReadonlySet<string>;
  complete: boolean;
  serverOutputs: ReadonlyMap<string, ReadonlySet<string>>;
}

function foldPath(path: string): string {
  return path.normalize('NFC').toLowerCase();
}

async function findOnDiskCaseSibling(candidate: string): Promise<string | null> {
  const exact = await lstat(candidate).catch((error) => {
    if ((error as NodeJS.ErrnoException | null | undefined)?.code === 'ENOENT') return null;
    throw error;
  });
  if (exact) return candidate;
  const dir = dirname(candidate);
  const target = foldPath(basename(candidate));
  const names = await readdir(dir).catch((error) => {
    if ((error as NodeJS.ErrnoException | null | undefined)?.code === 'ENOENT') return [];
    throw error;
  });
  const match = names.find((name) => foldPath(name) === target);
  return match ? join(dir, match) : null;
}

// loadLibraryRoots() returns a process-cached ReadonlyMap singleton until invalidateLibraryRoots().
let cachedRootEntries: {
  roots: ReadonlyMap<string, string>;
  entries: Promise<readonly (readonly [string, string])[]>;
} | null = null;

function libraryRootEntries(
  roots: ReadonlyMap<string, string>,
): Promise<readonly (readonly [string, string])[]> {
  if (cachedRootEntries?.roots !== roots) {
    cachedRootEntries = {
      roots,
      entries: (async () => {
        const entries: [string, string][] = [];
        for (const [id, root] of roots) {
          const resolved = resolve(root);
          entries.push([id, resolved]);
          const canonical = await realpath(resolved).catch(() => null);
          if (canonical && canonical !== resolved) entries.push([id, canonical]);
        }
        return entries;
      })(),
    };
  }
  return cachedRootEntries.entries;
}

export async function isCatalogAssetOrSidecar(candidate: string): Promise<string | null> {
  const entries = await libraryRootEntries(await loadLibraryRoots());
  const match = mostSpecificRoot(candidate, entries);
  if (!match || !match.relPath) return null;
  const existingPath = await findOnDiskCaseSibling(candidate);
  if (!existingPath) return null;
  if (extname(existingPath).toLowerCase() === '.xmp') return existingPath;
  const slash = match.relPath.lastIndexOf('/');
  const dir = slash === -1 ? '' : match.relPath.slice(0, slash);
  const filename = slash === -1 ? match.relPath : match.relPath.slice(slash + 1);
  return (await hasLiveAssetAtAddress(new ObjectId(match.key), dir, filename))
    ? existingPath
    : null;
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
  const key = foldPath(resolve(outputPath));
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
  const rawResolved = JSON.stringify(resolvedDir).slice(1, -1);
  const rawCanonical = JSON.stringify(canonicalDir).slice(1, -1);
  const resolvedNeedle = rawResolved.toLowerCase();
  const canonicalNeedle = rawCanonical.toLowerCase();
  const rows = await sqliteDb().read<{ ledger: string }>(
    `SELECT ledger
       FROM jobs
      WHERE kind IN ('batch_recipe_export', 'batch_jpeg_export')
        AND ledger IS NOT NULL
        AND (
          instr(ledger, ?) > 0
          OR instr(ledger, ?) > 0
          OR instr(lower(ledger), ?) > 0
          OR instr(lower(ledger), ?) > 0
        )`,
    [rawResolved, rawCanonical, resolvedNeedle, canonicalNeedle],
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
  const byResolved = originalPaths.serverOutputs.get(foldPath(resolvedOutput));
  if (byResolved?.has(currentHash)) return true;
  if (!canonicalOutput) return false;
  return originalPaths.serverOutputs.get(foldPath(canonicalOutput))?.has(currentHash) ?? false;
}
