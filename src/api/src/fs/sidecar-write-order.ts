/** One sequencing barrier for actual writes to a canonical allowed sidecar path (#4051). */
import * as fs from "node:fs/promises";
import * as path from "node:path";

const pendingWrites = new Map<string, Promise<void>>();
const inFlightKeys = new Map<string, Promise<string>>();
const admissionTails = new Map<string, Promise<void>>();

function canonicalKey(destination: string): Promise<string> {
  const existing = inFlightKeys.get(destination);
  if (existing) return existing;
  const pending = (async () => {
    const resolvedDestination = path.resolve(destination);
    const parent = path.dirname(resolvedDestination);
    const basename = path
      .basename(resolvedDestination)
      .normalize("NFC")
      .toLowerCase()
      .normalize("NFC");
    // Fold conservatively on every host: the destination may live on a
    // case-insensitive network or removable volume even when the API host is not.
    // stat follows parent symlinks and gives aliases the same directory
    // identity without resolving every path component through realpath.
    const parentStat = await fs
      .stat(parent, { bigint: true })
      .catch(() => null);
    return parentStat
      ? `inode:${parentStat.dev}:${parentStat.ino}:${basename}`
      : path
          .join(parent, basename)
          .normalize("NFC")
          .toLowerCase()
          .normalize("NFC");
  })();
  inFlightKeys.set(destination, pending);
  void pending.then(
    () => {
      if (inFlightKeys.get(destination) === pending)
        inFlightKeys.delete(destination);
    },
    () => {
      if (inFlightKeys.get(destination) === pending)
        inFlightKeys.delete(destination);
    },
  );
  return pending;
}

export async function serializeSidecarWrite<T>(
  destination: string,
  write: () => Promise<T>,
): Promise<T> {
  // Calls that may be parent-sibling aliases must register in invocation order
  // before their canonical parent identity is known. This gate covers only one
  // parent stat; the write chain itself is keyed by parent inode, so unrelated
  // sibling libraries never serialize their actual writes.
  const resolvedDestination = path.resolve(destination);
  const parent = path.dirname(resolvedDestination);
  const basename = path
    .basename(resolvedDestination)
    .normalize("NFC")
    .toLowerCase()
    .normalize("NFC");
  const admissionKey = path
    .join(path.dirname(parent), basename)
    .normalize("NFC")
    .toLowerCase()
    .normalize("NFC");
  const previousAdmission =
    admissionTails.get(admissionKey) ?? Promise.resolve();
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
    if (admissionTails.get(admissionKey) === currentAdmission)
      admissionTails.delete(admissionKey);
  }

  return next.finally(() => {
    if (pendingWrites.get(key) === settled) pendingWrites.delete(key);
  });
}
