import * as path from 'node:path';
import * as fs from '../fs/mirrored.ts';
import { isUnderRoot } from '../fs/browse.ts';

export interface ChildStat {
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
}

/** `direct` marks a child with no symlink in its final component, so its real path is
 * the directory's real path plus its name and its `stat` is the `lstat` that found it. */
export interface ChildFacts {
  real: string;
  stat: ChildStat;
  direct: boolean;
}

export type ChildInspector = (name: string) => Promise<ChildFacts | null>;

/** A request shares each child's checked realpath and stat. A direct child needs one `lstat`;
 * a symlinked one is realpathed against THIS library and followed, as before. */
export function childInspector(
  directory: string,
  realDirectory: string | null,
  realRoot: string,
): ChildInspector {
  const directoryInRoot = realDirectory !== null && isUnderRoot(realDirectory, realRoot);
  const known = new Map<string, Promise<ChildFacts | null>>();

  async function followed(name: string): Promise<ChildFacts | null> {
    const real = await fs
      .realpath(path.join(directory, name))
      .then((resolved) => (isUnderRoot(resolved, realRoot) ? resolved : null))
      .catch(() => null);
    const stat = real === null ? null : await fs.stat(real).catch(() => null);
    return real !== null && stat ? { real, stat, direct: false } : null;
  }

  async function inspect(name: string): Promise<ChildFacts | null> {
    if (!directoryInRoot || realDirectory === null) return followed(name);
    const stat = await fs.lstat(path.join(directory, name)).catch(() => null);
    if (stat === null) return null;
    return stat.isSymbolicLink()
      ? followed(name)
      : { real: path.join(realDirectory, name), stat, direct: true };
  }

  return (name) => {
    const cached = known.get(name);
    if (cached) return cached;
    const pending = inspect(name);
    known.set(name, pending);
    return pending;
  };
}
