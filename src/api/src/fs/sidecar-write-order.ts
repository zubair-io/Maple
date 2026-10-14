/** One sequencing barrier for actual writes to a canonical allowed sidecar path (#4051). */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

const pendingWrites = new Map<string, Promise<void>>();
const inFlightKeys = new Map<string, Promise<string>>();

function canonicalKey(destination: string): Promise<string> {
  const existing = inFlightKeys.get(destination);
  if (existing) return existing;
  const pending = (async () => {
    const parent = path.dirname(destination);
    const realParent = await fs.realpath(parent).catch(() => parent);
    return path.join(realParent, path.basename(destination));
  })();
  inFlightKeys.set(destination, pending);
  void pending.then(
    () => {
      if (inFlightKeys.get(destination) === pending) inFlightKeys.delete(destination);
    },
    () => {
      if (inFlightKeys.get(destination) === pending) inFlightKeys.delete(destination);
    },
  );
  return pending;
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
