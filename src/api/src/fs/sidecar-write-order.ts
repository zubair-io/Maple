/** One sequencing barrier for actual writes to a canonical allowed sidecar path (#4051). */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

const pendingWrites = new Map<string, Promise<void>>();

async function canonicalKey(destination: string): Promise<string> {
  const parent = path.dirname(destination);
  const realParent = await fs.realpath(parent).catch(() => parent);
  return path.join(realParent, path.basename(destination));
}

export async function serializeSidecarWrite<T>(
  destination: string,
  write: () => Promise<T>,
): Promise<T> {
  const key = await canonicalKey(destination);
  const previous = pendingWrites.get(key) ?? Promise.resolve();
  const next = previous.then(write);
  const settled = next.then(
    () => undefined,
    () => undefined,
  );
  pendingWrites.set(key, settled);
  return next.finally(() => {
    if (pendingWrites.get(key) === settled) pendingWrites.delete(key);
  });
}
