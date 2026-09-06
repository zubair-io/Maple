/** Collision-safe delivery; original files are read-only and only staged outputs are published. */
import { createHash, randomUUID } from 'node:crypto';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { open, realpath, lstat, stat, link, rename, rm } from '../fs/mirrored.ts';
import { safeWriteAllowed } from '../fs/root.ts';
import { resolveAndAuthorizePath } from '../routes/xmp-path-auth.ts';
import { tryGetRawFfi } from '../ffi/raw_ffi.ts';
import { ffiPool } from '../ffi/ffi-pool.ts';
import { EXPORT_ENCODERS } from '../generated/export-recipe.generated.ts';
import type { ExportRecipe } from '../generated/export-recipe.generated.ts';
import type { ExportTarget } from './export-payload.ts';

export interface ExportEntry {
  id: string;
  status: 'rendering' | 'prepared' | 'applied' | 'failed' | 'skipped';
  outputPath?: string;
  tempPath?: string;
  beforeHash?: string | null;
  afterHash?: string;
  reason?: string;
}

async function fileHash(path: string): Promise<string | null> {
  let file;
  try {
    file = await open(path, 'r');
  } catch (error) {
    if (hasCode(error, 'ENOENT')) return null;
    throw error;
  }
  try {
    const hash = createHash('sha256');
    const buffer = Buffer.alloc(65536);
    for (;;) {
      const { bytesRead } = await file.read(buffer);
      if (!bytesRead) break;
      hash.update(buffer.subarray(0, bytesRead));
    }
    return hash.digest('hex');
  } finally {
    await file.close();
  }
}

function hasCode(error: unknown, code: string): boolean {
  return !!error && typeof error === 'object' && 'code' in error && error.code === code;
}

export function exportFailure(error: unknown): string {
  if (hasCode(error, 'ENOSPC')) return 'Destination is full. Free space and retry this photo.';
  if (hasCode(error, 'EACCES') || hasCode(error, 'EPERM'))
    return 'Permission denied. Grant access to the original and destination, then retry.';
  if (hasCode(error, 'EEXIST'))
    return 'Output already exists. Choose another name or an explicit skip/replace policy.';
  return error instanceof Error ? error.message : String(error);
}

async function authorize(path: string): Promise<string> {
  const allowed = await resolveAndAuthorizePath(path);
  if (!allowed.ok) throw new Error(allowed.error);
  const canonical = await realpath(allowed.data);
  const writable = await safeWriteAllowed(canonical);
  if (!writable.ok) throw new Error(writable.error ?? 'Path is outside a writable library');
  return canonical;
}

interface ExportPaths {
  source: string;
  directory: string;
  outputPath: string;
}

async function exportPaths(
  target: ExportTarget,
  recipe: ExportRecipe,
  originalPaths: ReadonlySet<string>,
): Promise<ExportPaths> {
  const source = await authorize(target.path);
  const directory = await authorize(recipe.directory!);
  if (!(await stat(source)).isFile() || !(await stat(directory)).isDirectory())
    throw new Error('Original must be a file and destination must be an existing directory');
  const encoder = EXPORT_ENCODERS.find((entry) => entry.format === recipe.format)!;
  const native = tryGetRawFfi();
  if (!native) throw new Error('Recipe encoder unavailable. Rebuild or install raw-ffi.');
  const filename = native.renderFilenameTemplate({
    template: recipe.namingTemplate,
    originalStem: basename(source, extname(source)),
    ext: encoder.extension,
    capturedAt: target.capturedAt,
    sequenceStart: 1,
    sequenceIndex: target.index,
    sequencePadWidth: 0,
  });
  if (!filename.ok) throw new Error(filename.error);
  if (!filename.name.endsWith(`.${encoder.extension}`))
    throw new Error('Naming template must use the selected format extension: {ext}');
  const outputPath = join(directory, filename.name);
  await guardOriginal(outputPath, source, originalPaths);
  return { source, directory, outputPath };
}

async function guardOriginal(
  outputPath: string,
  source: string,
  originalPaths: ReadonlySet<string>,
) {
  const canonicalOutput = await realpath(outputPath).catch(() => null);
  if (
    originalPaths.has(resolve(outputPath)) ||
    originalPaths.has(canonicalOutput ?? '') ||
    canonicalOutput === source
  )
    throw new Error('Destination is the original. Choose another directory or naming template.');
}

async function recoverPrepared(
  previous: ExportEntry,
  outputPath: string,
  currentHash: string | null,
): Promise<ExportEntry> {
  if (previous.outputPath !== outputPath)
    throw new Error('Saved destination changed; review this export before retrying');
  if (currentHash === previous.afterHash) return { ...previous, status: 'applied' };
  if (currentHash !== previous.beforeHash)
    throw new Error('Output changed while the job was interrupted; review it before retrying');
  if (previous.tempPath && (await fileHash(previous.tempPath)) === previous.afterHash)
    return previous;
  throw new Error('Prepared output is missing or changed; retry this photo to render it again');
}

async function validateStagingPath(
  entry: ExportEntry,
  directory: string,
  jobId: string,
  originals: ReadonlySet<string>,
): Promise<void> {
  const temp = entry.tempPath;
  if (
    !temp ||
    resolve(temp) !== temp ||
    dirname(temp) !== directory ||
    !isStagingName(basename(temp), jobId)
  )
    throw new Error('Saved staging path does not belong to this export job and destination');
  await guardOriginal(temp, '', originals);
  const info = await lstat(temp).catch((error) => {
    if (hasCode(error, 'ENOENT')) return null;
    throw error;
  });
  if (info && (!info.isFile() || info.isSymbolicLink()))
    throw new Error('Staging output must be a regular file, not a link or directory');
}

function isStagingName(name: string, jobId: string): boolean {
  const prefix = `.maple-export-${jobId}-`;
  return (
    name.startsWith(prefix) &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.tmp$/.test(
      name.slice(prefix.length),
    )
  );
}

async function commitStaging(
  temp: string,
  output: string,
  policy: string,
): Promise<'applied' | 'skipped'> {
  if (policy === 'replace') {
    await rename(temp, output);
    return 'applied';
  }
  try {
    await link(temp, output);
    return 'applied';
  } catch (error) {
    if (!hasCode(error, 'EEXIST') || policy !== 'skip') throw error;
    return 'skipped';
  }
}

async function recoverRendering(
  previous: ExportEntry,
  outputPath: string,
  currentHash: string | null,
): Promise<void> {
  if (previous.outputPath !== outputPath || previous.beforeHash !== currentHash)
    throw new Error('Output changed while rendering was interrupted; review it before retrying');
  if (previous.tempPath) await rm(previous.tempPath, { force: true });
}

async function renderStaging(
  target: ExportTarget,
  recipe: ExportRecipe,
  paths: ExportPaths,
  entry: ExportEntry,
): Promise<ExportEntry> {
  const tempPath = entry.tempPath!;
  try {
    const localFilms = resolve(import.meta.dir, '../../../../resources/film-luts');
    const filmDirectory = await stat(localFilms)
      .then(() => localFilms)
      .catch(() => resolve(import.meta.dir, '../../film-luts'));
    const ok = await ffiPool().exportRecipeToFile(
      paths.source,
      target.xmp,
      JSON.stringify(recipe),
      filmDirectory,
      tempPath,
    );
    if (!ok) throw new Error('Encoder failed without producing an output');
    const afterHash = await fileHash(tempPath);
    if (!afterHash) throw new Error('Encoder did not produce a staging file');
    return { ...entry, status: 'prepared', afterHash };
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

export async function prepareExport(
  target: ExportTarget,
  recipe: ExportRecipe,
  jobId: string,
  previous: ExportEntry | null,
  originalPaths: ReadonlySet<string>,
  beforeRender: (entry: ExportEntry) => Promise<void>,
): Promise<ExportEntry> {
  const paths = await exportPaths(target, recipe, originalPaths);
  const currentHash = await fileHash(paths.outputPath);
  if (previous?.status === 'prepared' || previous?.status === 'rendering')
    await validateStagingPath(previous, paths.directory, jobId, originalPaths);
  if (previous?.status === 'prepared')
    return recoverPrepared(previous, paths.outputPath, currentHash);
  if (previous?.status === 'rendering')
    await recoverRendering(previous, paths.outputPath, currentHash);
  if (currentHash !== null && recipe.overwritePolicy === 'skip')
    return { id: target.id, status: 'skipped', outputPath: paths.outputPath };
  if (currentHash !== null && recipe.overwritePolicy === 'error')
    throw new Error(
      `Output already exists: ${paths.outputPath}. Choose another name, skip, or replace.`,
    );
  const entry: ExportEntry = {
    id: target.id,
    status: 'rendering',
    outputPath: paths.outputPath,
    tempPath: join(paths.directory, `.maple-export-${jobId}-${randomUUID()}.tmp`),
    beforeHash: currentHash,
  };
  await validateStagingPath(entry, paths.directory, jobId, originalPaths);
  // Persist the staging identity before the native child can create any bytes.
  await beforeRender(entry);
  return renderStaging(target, recipe, paths, entry);
}

export async function publishExport(
  entry: ExportEntry,
  recipe: ExportRecipe,
  jobId: string,
  originals: ReadonlySet<string>,
): Promise<ExportEntry> {
  if (!entry.tempPath || !entry.outputPath || !entry.afterHash)
    throw new Error('Incomplete prepared export');
  const directory = await authorize(recipe.directory!);
  await validateStagingPath(entry, directory, jobId, originals);
  if (dirname(entry.outputPath) !== directory)
    throw new Error('Saved output is outside the selected destination');
  await guardOriginal(entry.outputPath, '', originals);
  const currentHash = await fileHash(entry.outputPath);
  if (currentHash !== entry.beforeHash) {
    if (currentHash !== null && recipe.overwritePolicy === 'skip') {
      await rm(entry.tempPath, { force: true }).catch(() => undefined);
      return { ...entry, status: 'skipped' };
    }
    throw new Error('Output changed before publication; review it before retrying');
  }
  if ((await fileHash(entry.tempPath)) !== entry.afterHash)
    throw new Error(
      'Prepared output changed before publication; retry this photo to render it again',
    );
  const status = await commitStaging(entry.tempPath, entry.outputPath, recipe.overwritePolicy);
  // Publication already committed; an orphaned staging link must not turn success into failure.
  await rm(entry.tempPath, { force: true }).catch(() => undefined);
  return { ...entry, status };
}
