/** Save admission across Replace publication and verified copy-based rollback (#5165). */
import * as path from 'node:path';
import { realpath, stat } from './mirrored';

interface Replacement {
  active: boolean;
  original: string | null;
  restored: string | null;
}
const replacements = new Map<string, Replacement>();

export async function primaryIdentity(file: string): Promise<string | null> {
  return stat(file, { bigint: true }).then(
    (value) => `${value.dev}:${value.ino}:${value.size}:${value.mtimeNs}`,
    (error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    },
  );
}

/** Replace publishes over the named directory entry, including a symlink.
 * Resolving the final component would change the generation key mid-commit. */
export async function primaryReplacementKey(file: string): Promise<string> {
  const absolute = path.resolve(file);
  // Match the sidecar reservation's conservative Unicode/case aliasing.
  // Rollback receipts still require the exact original and restored identities.
  return path
    .join(await canonicalDirectory(path.dirname(absolute)), path.basename(absolute))
    .normalize('NFC')
    .toLowerCase()
    .normalize('NFC');
}

async function canonicalDirectory(directory: string): Promise<string> {
  try {
    return await realpath(directory);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    const parent = path.dirname(directory);
    if (parent === directory) throw error;
    return path.join(await canonicalDirectory(parent), path.basename(directory));
  }
}

/** Snapshot the active flag as well as the entry: finishing cannot retroactively
 * authorize a request that observed an uncommitted photo. */
export function replacementAdmission(key: string) {
  const entry = replacements.get(key);
  return { entry, active: entry?.active ?? false };
}

export function replacementAllowsSave(
  key: string,
  admitted: ReturnType<typeof replacementAdmission>,
  original: string | null,
  current: string | null,
): boolean {
  const latest = replacements.get(key);
  if (admitted.active || latest?.active) return false;
  return (
    original === current ||
    (latest !== undefined &&
      latest !== admitted.entry &&
      original !== null &&
      latest.original === original &&
      latest.restored !== null &&
      latest.restored === current)
  );
}

export async function withPrimaryReplacement<T>(files: string[], operation: () => Promise<T>) {
  const prepared = await Promise.all(
    files.map(async (file) => {
      const key = await primaryReplacementKey(file);
      const entry: Replacement = {
        active: true,
        original: await primaryIdentity(file),
        restored: null,
      };
      return { key, entry };
    }),
  );
  for (const { key, entry } of prepared) {
    replacements.delete(key);
    replacements.set(key, entry);
  }
  try {
    return await operation();
  } finally {
    for (const { entry } of prepared) entry.active = false;
    // Retain only recent completed rollbacks. Evicting an older receipt can
    // conservatively refuse a stale save; it can never accept the wrong photo.
    for (const [key, entry] of replacements) {
      if (replacements.size <= 256) break;
      if (!entry.active) replacements.delete(key);
    }
  }
}

/** Called only after publishExclusive verified the displaced bytes at their
 * restored name. A failed rollback must never bless the incoming primary. */
export async function recordVerifiedPrimaryRollback(destination: string): Promise<void> {
  const key = await primaryReplacementKey(destination);
  const entry = replacements.get(key);
  if (entry?.active) entry.restored = await primaryIdentity(destination);
}
