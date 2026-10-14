/** One sequencing barrier for actual writes to a canonical allowed sidecar path (#4051). */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

const pendingWrites = new Map<string, Promise<void>>();
const inFlightKeys = new Map<string, Promise<string>>();
const caseInsensitivePaths = process.platform === 'darwin' || process.platform === 'win32';
let admissionTail: Promise<void> = Promise.resolve();

function canonicalKey(destination: string): Promise<string> {
  const existing = inFlightKeys.get(destination);
  if (existing) return existing;
  const pending = (async () => {
    const parent = path.dirname(destination);
    const realParent = await fs.realpath(parent).catch(() => parent);
    const basename = path.basename(destination);
    return path.join(realParent, caseInsensitivePaths ? basename.toLowerCase() : basename);
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
  const previousAdmission = admissionTail;
  let releaseAdmission!: () => void;
  admissionTail = new Promise<void>((resolve) => {
    releaseAdmission = resolve;
  });
  await previousAdmission;

  let next: Promise<T>;
  let settled: Promise<void>;
  let key: string;
  try {
    // Admit writes in call order before yielding the key to the per-file queue.
    // Different aliases can resolve their parents at different speeds; without
    // this short admission gate, the later call may register first.
    key = await canonicalKey(destination);
    const previous = pendingWrites.get(key) ?? Promise.resolve();
    next = previous.then(write);
    settled = next.then(
      () => undefined,
      () => undefined,
    );
    pendingWrites.set(key, settled);
  } finally {
    releaseAdmission();
  }

  return next.finally(() => {
    if (pendingWrites.get(key) === settled) pendingWrites.delete(key);
  });
}
