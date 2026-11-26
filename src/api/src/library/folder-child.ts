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

// Bun's macOS realpath opens its target, so a child this process cannot open was never listed there.
const REALPATH_OPENS_TARGET = process.platform === 'darwin';

async function opens(target: string): Promise<boolean> {
  const handle = await fs
    .open(target, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK)
    .catch(() => null);
  await handle?.close();
  return handle !== null;
}

/** A granted answer serves every later call. A refusal is never shared: it may be a passing
 * failure, so each caller that meets one asks again for its own argument. */
export function sharedGrant<Arg>(grants: (arg: Arg) => Promise<boolean>) {
  const memo: { granted?: Promise<boolean> } = {};
  return async (arg: Arg): Promise<boolean> => {
    const shared = (memo.granted ??= grants(arg).catch(() => false));
    if (await shared) return true;
    if (memo.granted === shared) delete memo.granted;
    return grants(arg);
  };
}

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
    const listed = path.join(directory, name);
    const stat = await fs.lstat(listed).catch(() => null);
    if (stat === null) return null;
    if (stat.isSymbolicLink()) return followed(name);
    if (REALPATH_OPENS_TARGET && !(await opens(listed))) return null;
    return { real: path.join(realDirectory, name), stat, direct: true };
  }

  return (name) => {
    const cached = known.get(name);
    if (cached) return cached;
    const pending = inspect(name);
    known.set(name, pending);
    return pending;
  };
}
