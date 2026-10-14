/** One sequencing barrier for actual writes to a canonical allowed sidecar path (#4051). */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

const pendingWrites = new Map<string, Promise<void>>();
const inFlightKeys = new Map<string, Promise<string>>();
const admissionTails = new Map<string, Promise<void>>();

function canonicalKey(destination: string): Promise<string> {
  const existing = inFlightKeys.get(destination);
  if (existing) return existing;
  const pending = (async () => {
    const parent = path.dirname(destination);
    const realParent = await fs.realpath(parent).catch(() => parent);
    const basename = path.basename(destination);
    // Fold conservatively on every host: the destination may live on a
    // case-insensitive network or removable volume even when the API host is not.
    return path.join(realParent, basename).toLowerCase();
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
  // Parent-sibling aliases (a real directory and a symlink beside it) must
  // register in call order, while libraries in separate directory trees with
  // a reused filename get independent admission. The canonical write chain
  // below joins aliases after resolution; this short-lived key only orders the
  // candidate sibling paths during that lookup. Folding includes case-only
  // aliases on every host.
  const parent = path.dirname(path.resolve(destination));
  const admissionKey = path.join(path.dirname(parent), path.basename(destination)).toLowerCase();
  const previousAdmission = admissionTails.get(admissionKey) ?? Promise.resolve();
  let releaseAdmission!: () => void;
  const currentAdmission = new Promise<void>((resolve) => {
    releaseAdmission = resolve;
  });
  admissionTails.set(admissionKey, currentAdmission);
  const canonicalKeyPromise = canonicalKey(destination);

  let next: Promise<T>;
  let settled: Promise<void>;
  let key: string;
  try {
    await previousAdmission;
    // Resolve parent paths concurrently; wait for earlier same-basename calls
    // before registering so a faster alias cannot overtake an earlier one.
    key = await canonicalKeyPromise;
    const previous = pendingWrites.get(key) ?? Promise.resolve();
    next = previous.then(write);
    settled = next.then(
      () => undefined,
      () => undefined,
    );
    pendingWrites.set(key, settled);
  } finally {
    releaseAdmission();
    if (admissionTails.get(admissionKey) === currentAdmission) admissionTails.delete(admissionKey);
  }

  return next.finally(() => {
    if (pendingWrites.get(key) === settled) pendingWrites.delete(key);
  });
}
