import { dirname } from 'node:path';
import { lstat, stat } from '../fs/mirrored.ts';
import { xmpSidecarPath } from '../fs/xmp.ts';
import { adoptLegacyDerivative } from '../fs/legacy-derivative.ts';

export async function assertDerivativeCacheDirectory(cachePath: string): Promise<void> {
  const tier = dirname(cachePath);
  for (const directory of [dirname(tier), tier]) {
    const entry = await lstat(directory).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (entry && !entry.isDirectory())
      throw new Error(`Unsafe derivative cache directory: ${directory}`);
  }
}

export async function isDerivativeCacheFresh(
  cachePath: string,
  sourcePath: string,
): Promise<boolean> {
  const cached =
    (await lstat(cachePath).catch(() => null)) ??
    ((await adoptLegacyDerivative(cachePath)) ? await lstat(cachePath).catch(() => null) : null);
  if (!cached?.isFile() || cached.size === 0) return false;
  const [source, sidecar] = await Promise.all([
    stat(sourcePath).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    }),
    stat(xmpSidecarPath(sourcePath)).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    }),
  ]);
  return cached.mtimeMs >= Math.max(source?.mtimeMs ?? 0, sidecar?.mtimeMs ?? 0);
}

/** A stage must not record a render that published no derivative as done
 * (#5474); throwing hands it to the runner's retry/dead-letter path. A
 * vanished original rethrows its own ENOENT so the runner tags it missing. */
export async function assertDerivativeRendered(
  rendered: boolean,
  cachePath: string,
  sourcePath: string,
): Promise<void> {
  if (rendered) return;
  await stat(sourcePath);
  throw new Error(`Derivative render produced no file at ${cachePath}`);
}
