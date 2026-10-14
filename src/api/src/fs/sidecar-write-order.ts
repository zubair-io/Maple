/** One sequencing barrier for actual writes to a canonical allowed sidecar path (#4051). */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

const pendingWrites = new Map<string, Promise<void>>();
const inFlightKeys = new Map<string, Promise<string>>();
const admissionTails = new Map<string, Promise<void>>();

export interface SidecarWriteOrderOptions {
  /** Stable library identity shared by lexical and symlinked paths. */
  admissionScope?: string;
  /** Resolve and authorize the path after its FIFO admission has been registered. */
  resolveDestination?: () => Promise<string>;
}

export class SidecarWritePathDeniedError extends Error {}

function canonicalKey(destination: string): Promise<string> {
  const existing = inFlightKeys.get(destination);
  if (existing) return existing;
  const pending = (async () => {
    const resolvedDestination = path.resolve(destination);
    const parent = path.dirname(resolvedDestination);
    const basename = path
      .basename(resolvedDestination)
      .normalize('NFC')
      .toLowerCase()
      .normalize('NFC');
    // Fold conservatively on every host: the destination may live on a
    // case-insensitive network or removable volume even when the API host is not.
    // stat follows parent symlinks and gives aliases the same directory
    // identity without resolving every path component through realpath.
    const parentStat = await fs.stat(parent, { bigint: true }).catch(() => null);
    return parentStat
      ? `inode:${parentStat.dev}:${parentStat.ino}:${basename}`
      : path.join(parent, basename).normalize('NFC').toLowerCase().normalize('NFC');
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
  write: (resolvedDestination: string) => Promise<T>,
  options: SidecarWriteOrderOptions = {},
): Promise<T> {
  // Register arrival before any asynchronous authorization or canonicalization.
  // The library scope groups aliases at different directory depths while
  // keeping same-named files in sibling libraries independent.
  const resolvedDestination = path.resolve(destination);
  const admissionScope = path.resolve(
    options.admissionScope ?? path.dirname(path.dirname(resolvedDestination)),
  );
  // The lexical filename cannot identify every alias: two different file
  // symlinks may resolve to the same sidecar. Admit path resolution in library
  // arrival order, then serialize writes only by the canonical destination.
  const admissionKey = admissionScope.normalize('NFC').toLowerCase().normalize('NFC');
  const previousAdmission = admissionTails.get(admissionKey) ?? Promise.resolve();
  let releaseAdmission!: () => void;
  const currentAdmission = new Promise<void>((resolve) => {
    releaseAdmission = resolve;
  });
  admissionTails.set(admissionKey, currentAdmission);
  const destinationPromise = Promise.resolve()
    .then(() => options.resolveDestination?.() ?? destination)
    .then((resolved) => path.resolve(resolved));
  const canonicalKeyPromise = destinationPromise.then(canonicalKey);

  let next: Promise<T>;
  let settled: Promise<void>;
  let key: string;
  let actualDestination: string;
  try {
    await previousAdmission;
    // Resolve paths concurrently, but register their canonical write chains in
    // admission order so a faster alias cannot overtake an earlier save.
    [actualDestination, key] = await Promise.all([destinationPromise, canonicalKeyPromise]);
    const previous = pendingWrites.get(key) ?? Promise.resolve();
    next = previous.then(() => write(actualDestination));
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
