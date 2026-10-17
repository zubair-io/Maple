/**
 * One-time adoption of the retired pipeline-versioned derivative names.
 *
 * Shared derivatives are `.maple/thumbs/<filename>.avif` and
 * `.maple/previews/<filename>.avif` (#4793). They were briefly written with a
 * pipeline version — previews as `<filename>.v<N>.avif`, thumbs under the
 * retired hashed name `<sha256_prefix16(filename)>.v<N>.avif`. The migration is
 * a rename, never a regeneration: `cache-gc` renames the newest legacy file in
 * every folder it sweeps, and readers call `adoptLegacyDerivative` on a miss so
 * a folder the sweep hasn't reached yet still serves its existing file
 * instantly. Every install that wrote versioned names did so at version 25, so
 * the read path only ever needs to try that one frozen name.
 */
import * as path from 'node:path';
// Mirror-aware: the rename replicates to the library's backup root too.
import * as fs from './mirrored.ts';
import { sha256Prefix16 } from './xmp.ts';

const LEGACY_DERIVATIVE_VERSION = 25;

const VERSIONED_NAME_RE =
  /^(.*)\.v([1-9][0-9]*)(\.(?:avif|jpg|webp|png)(?:\.source\.json)?|\.preview\.json)$/;

/** `<name>.v<N>.<kind>` → `{ unversioned: '<name>.<kind>', version: N }`, or
 * `null` for a name that carries no retired pipeline-version segment. */
export function parseVersionedDerivativeName(
  name: string,
): { unversioned: string; version: number } | null {
  const match = VERSIONED_NAME_RE.exec(name);
  return match ? { unversioned: `${match[1]}${match[3]}`, version: Number(match[2]) } : null;
}

/** The frozen legacy name a reader adopts on a miss, or `null` for a
 * non-AVIF path: `previews/<filename>.avif` → `previews/<filename>.v25.avif`,
 * `thumbs/<filename>.avif` → `thumbs/<sha256_prefix16(filename)>.v25.avif`. */
export function legacyDerivativePath(cachePath: string): string | null {
  if (path.extname(cachePath) !== '.avif') return null;
  const dir = path.dirname(cachePath);
  const stem = path.basename(cachePath, '.avif');
  const legacyStem = path.basename(dir) === 'thumbs' ? sha256Prefix16(stem) : stem;
  return path.join(dir, `${legacyStem}.v${LEGACY_DERIVATIVE_VERSION}.avif`);
}

export type NoClobberMove = 'moved' | 'exists' | 'failed';

const LINK_UNSUPPORTED = new Set(['ENOTSUP', 'EOPNOTSUPP', 'EPERM', 'EXDEV', 'ENOSYS']);

/**
 * Move `from` to `to` without ever replacing `to`. A plain `rename` would
 * overwrite a fresh derivative a stage published after the caller looked, so
 * this publishes with `link` (fails with EEXIST) and then drops `from`.
 * Filesystems without hard links fall back to check-then-rename. Never throws.
 */
export async function moveNoClobber(from: string, to: string): Promise<NoClobberMove> {
  const linkError = await fs.link(from, to).then(
    () => null,
    (err: NodeJS.ErrnoException) => err.code ?? 'UNKNOWN',
  );
  if (linkError === null) {
    await fs.unlink(from).catch(() => {});
    return 'moved';
  }
  if (linkError === 'EEXIST') return 'exists';
  if (!LINK_UNSUPPORTED.has(linkError)) return 'failed';
  if (
    await fs.lstat(to).then(
      () => true,
      () => false,
    )
  )
    return 'exists';
  return fs.rename(from, to).then(
    () => 'moved',
    () => 'failed',
  );
}

/**
 * On a cache miss for `cachePath`, move its frozen legacy sibling into place.
 * Resolves `true` when `cachePath` now exists — adopted here, or published by
 * someone else first, in which case it is kept and the legacy file is left for
 * cache-gc. Never overwrites, never throws — a failed adoption is just a miss.
 */
export async function adoptLegacyDerivative(cachePath: string): Promise<boolean> {
  const legacy = legacyDerivativePath(cachePath);
  if (legacy === null) return false;
  return (await moveNoClobber(legacy, cachePath)) !== 'failed';
}

/** `readFile` that adopts the frozen legacy name on a miss before giving up. */
export async function readDerivative(cachePath: string): Promise<Buffer> {
  try {
    return await fs.readFile(cachePath);
  } catch (err) {
    const missing = (err as NodeJS.ErrnoException | null)?.code === 'ENOENT';
    if (missing && (await adoptLegacyDerivative(cachePath))) return fs.readFile(cachePath);
    throw err;
  }
}
