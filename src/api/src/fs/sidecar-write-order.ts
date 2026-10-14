/** One sequencing barrier for actual writes to a canonical allowed sidecar path (#4051). */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

const pendingWrites = new Map<string, Promise<void>>();
const inFlightKeys = new Map<string, Promise<string>>();
let admissionTail: Promise<void> | undefined;

export interface SidecarWriteOrderOptions {
  /** Caller root retained for compatibility; admission coordinates aliases globally. */
  admissionScope?: string;
  /** Resolve and authorize the path after its FIFO admission has been registered. */
  resolveDestination?: () => Promise<string>;
  /** Stop waiting for destination admission when its request is aborted. */
  signal?: AbortSignal;
}

export function waitForAbortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  signal.throwIfAborted();
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () =>
      reject(signal.reason ?? new DOMException('The operation was aborted', 'AbortError'));
    signal.addEventListener('abort', onAbort, { once: true });
  });
  return Promise.race([promise, aborted]).finally(() => {
    if (onAbort) signal.removeEventListener('abort', onAbort);
  });
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
    // Do not fall back to a lexical key if stat fails. Once the filesystem
    // recovers, the same destination would switch to an inode key and bypass
    // a write that is still queued under the fallback spelling.
    const parentStat = await fs.stat(parent, { bigint: true });
    return `inode:${parentStat.dev}:${parentStat.ino}:${basename}`;
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

function discardCanonicalKey(destination: string, pending: Promise<string>): void {
  if (inFlightKeys.get(destination) === pending) inFlightKeys.delete(destination);
}

export async function serializeSidecarWrite<T>(
  destination: string,
  write: (resolvedDestination: string) => Promise<T>,
  options: SidecarWriteOrderOptions = {},
): Promise<T> {
  // Register arrival before any asynchronous authorization or canonicalization.
  // File symlinks can cross library boundaries, so a per-library queue cannot
  // preserve FIFO for two names that resolve to the same sidecar. This global
  // admission queue only orders destination registration; actual writes to
  // different canonical destinations still run concurrently below.
  // The lexical filename cannot identify every alias: two different file
  // symlinks may resolve to the same sidecar. Admit path resolution in request
  // arrival order, then serialize writes only by the canonical destination.
  const previousAdmission = admissionTail ?? Promise.resolve();
  let releaseAdmission!: () => void;
  const currentAdmission = new Promise<void>((resolve) => {
    releaseAdmission = resolve;
  });
  admissionTail = currentAdmission;
  let canonicalDestination: string | undefined;
  let canonicalKeyRequest: Promise<string> | undefined;
  const destinationPromise = Promise.resolve()
    .then(() => options.resolveDestination?.() ?? destination)
    .then((resolved) => {
      canonicalDestination = path.resolve(resolved);
      return canonicalDestination;
    });
  const canonicalKeyPromise = destinationPromise.then((resolved) => {
    options.signal?.throwIfAborted();
    canonicalKeyRequest = canonicalKey(resolved);
    return canonicalKeyRequest;
  });
  // A later admission can be waiting behind a slow earlier resolution while
  // its own destination is rejected. Attach a handler now so Bun/Node do not
  // report that expected request failure as an unhandled rejection before the
  // FIFO turn reaches Promise.all below.
  void canonicalKeyPromise.catch(() => undefined);
  const destinationKeysPromise = Promise.all([destinationPromise, canonicalKeyPromise]).then(
    ([actualDestination, inodeKey]) => {
      const lexicalKey = `path:${path
        .resolve(actualDestination)
        .normalize('NFC')
        .toLowerCase()
        .normalize('NFC')}`;
      return { actualDestination, keys: [...new Set([lexicalKey, inodeKey])] };
    },
  );
  void destinationKeysPromise.catch(() => undefined);

  let next: Promise<T>;
  let settled: Promise<void>;
  let keys: string[];
  try {
    await previousAdmission;
    // Resolve paths concurrently, but register their canonical write chains in
    // admission order so a faster alias cannot overtake an earlier save.
    const result = await waitForAbortable(destinationKeysPromise, options.signal);
    keys = result.keys;
    const previous = Promise.all(keys.map((key) => pendingWrites.get(key) ?? Promise.resolve()));
    next = previous.then(() => write(result.actualDestination));
    settled = next.then(
      () => undefined,
      () => undefined,
    );
    for (const key of keys) pendingWrites.set(key, settled);
  } finally {
    if (options.signal?.aborted && canonicalDestination && canonicalKeyRequest) {
      discardCanonicalKey(canonicalDestination, canonicalKeyRequest);
    }
    releaseAdmission();
    if (admissionTail === currentAdmission) admissionTail = undefined;
  }

  return next.finally(() => {
    for (const key of keys) {
      if (pendingWrites.get(key) === settled) pendingWrites.delete(key);
    }
  });
}
