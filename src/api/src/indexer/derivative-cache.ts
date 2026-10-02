import { dirname } from 'node:path';
import { lstat, stat } from '../fs/mirrored.ts';
import { xmpSidecarPath } from '../fs/xmp.ts';

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
  const cached = await lstat(cachePath).catch(() => null);
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
