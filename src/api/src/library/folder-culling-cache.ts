import * as fs from '../fs/mirrored.ts';
import type { ChildStat } from './folder-child.ts';
import { parseFolderCulling, type FolderCulling } from './folder-culling.ts';

/** Enough for every sidecar in several very large folders; each entry is a few hundred bytes. */
const MAX_ENTRIES = 20_000;

interface Remembered {
  identity: string;
  culling: FolderCulling;
  mtimeMs: number;
}

export type SidecarCulling = Pick<Remembered, 'culling' | 'mtimeMs'>;

const remembered = new Map<string, Remembered>();

type Identified = Pick<ChildStat, 'dev' | 'ino' | 'size' | 'mtimeMs' | 'ctimeMs'>;

/** Any rewrite (temp-then-rename or in place) changes the inode, size, mtime or ctime. */
function identityOf(stat: Identified): string {
  return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
}

function remember(sidecar: string, entry: Remembered): void {
  remembered.delete(sidecar);
  remembered.set(sidecar, entry);
  if (remembered.size <= MAX_ENTRIES) return;
  const oldest = remembered.keys().next().value;
  if (oldest !== undefined) remembered.delete(oldest);
}

/** Culling for an authorized sidecar path, parsed only when the file changed since the last
 * listing. A caller that has just `lstat`ed a plain file passes it as `listed`, so an unchanged
 * file costs no open. Opens without following a final symlink, like `readSidecarNoFollow`, and identifies
 * the file through the open handle so a swap between stat and read cannot pin stale culling. */
export async function readFolderCulling(
  sidecar: string,
  listed?: Identified,
): Promise<SidecarCulling> {
  const unchanged = listed && remembered.get(sidecar);
  if (unchanged && unchanged.identity === identityOf(listed)) {
    remember(sidecar, unchanged);
    return unchanged;
  }
  const handle = await fs.open(sidecar, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    const identity = identityOf(stat);
    const known = remembered.get(sidecar);
    if (known?.identity === identity) {
      remember(sidecar, known);
      return known;
    }
    const entry = {
      identity,
      culling: parseFolderCulling(await handle.readFile('utf8')),
      mtimeMs: stat.mtimeMs,
    };
    remember(sidecar, entry);
    return entry;
  } finally {
    await handle.close();
  }
}

export function forgetFolderCullingForTests(): void {
  remembered.clear();
}
