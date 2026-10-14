/** Scoped admission and canonical-path sequencing for sidecar writes (#4051). */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

const pendingWrites = new Map<string, Promise<void>>();
const inFlightKeys = new Map<string, Promise<string[]>>();
const admissionTails = new Map<string, Promise<void>>();

export interface SidecarWriteOrderOptions {
  /** Library root used to keep slow destination checks from blocking other libraries. */
  admissionScope?: string;
  /** Resolve and authorize the destination before invoking the write callback. */
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

function canonicalKeys(destination: string): Promise<string[]> {
  const existing = inFlightKeys.get(destination);
  if (existing) return existing;
  const pending = (async () => {
    const lexicalDestination = path.resolve(destination);
    const resolvedDestination = await fs.realpath(lexicalDestination).catch((error: unknown) => {
      if (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        (error.code === 'ENOENT' || error.code === 'ENOTDIR')
      ) {
        return null;
      }
      throw error;
    });
    const canonicalDestination =
      resolvedDestination ??
      path.join(
        await fs.realpath(path.dirname(lexicalDestination)).catch((error: unknown) => {
          if (
            typeof error === 'object' &&
            error !== null &&
            'code' in error &&
            (error.code === 'ENOENT' || error.code === 'ENOTDIR')
          ) {
            return path.dirname(lexicalDestination);
          }
          throw error;
        }),
        path.basename(lexicalDestination),
      );
    const parent = path.dirname(canonicalDestination);
    const basename = path
      .basename(canonicalDestination)
      .normalize('NFC')
      .toLowerCase()
      .normalize('NFC');
    // Fold conservatively on every host: the destination may live on a
    // case-insensitive network or removable volume even when the API host is not.
    // realpath folds existing file symlinks; stat follows parent symlinks and
    // gives missing sidecars the same directory identity as their aliases.
    // Do not fall back to a lexical key if stat fails. Once the filesystem
    // recovers, the same destination would switch to an inode key and bypass
    // a write that is still queued under the fallback spelling.
    const parentStat = await fs.stat(parent, { bigint: true });
    return [
      lexicalKey(canonicalDestination),
      `inode:${parentStat.dev}:${parentStat.ino}:${basename}`,
    ];
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

function lexicalKey(destination: string): string {
  return `path:${path.resolve(destination).normalize('NFC').toLowerCase().normalize('NFC')}`;
}

function destinationKeys(
  destination: string,
  canonicalRequest: Promise<string[]>,
): Promise<string[]> {
  return canonicalRequest.then((keys) => [...new Set([lexicalKey(destination), ...keys])]);
}

function discardCanonicalKey(destination: string, pending: Promise<string[]>): void {
  if (inFlightKeys.get(destination) === pending) inFlightKeys.delete(destination);
}

export async function serializeSidecarWrite<T>(
  destination: string,
  write: (resolvedDestination: string) => Promise<T>,
  options: SidecarWriteOrderOptions = {},
): Promise<T> {
  // Keep admission ordered within a library, while reserving canonical path
  // keys before potentially slow authorization. This lets aliases queue in
  // arrival order without making unrelated libraries wait for path checks.
  const admissionScope = path
    .resolve(options.admissionScope ?? path.dirname(destination))
    .normalize('NFC')
    .toLowerCase()
    .normalize('NFC');
  const previousAdmission = admissionTails.get(admissionScope) ?? Promise.resolve();
  let releaseAdmission!: () => void;
  const currentAdmission = new Promise<void>((resolve) => {
    releaseAdmission = resolve;
  });
  admissionTails.set(admissionScope, currentAdmission);
  let canonicalKeyRequest: Promise<string[]> | undefined;
  let releaseReservation: (() => void) | undefined;
  let reservation: Promise<void> | undefined;
  let reservedKeys: string[] = [];
  let reservationRegistered = false;
  const destinationPromise = Promise.resolve().then(
    () => options.resolveDestination?.() ?? destination,
  );
  void destinationPromise.catch(() => undefined);

  try {
    await waitForAbortable(previousAdmission, options.signal);
    canonicalKeyRequest = canonicalKeys(destination);
    void canonicalKeyRequest.catch(() => undefined);
    reservedKeys = await waitForAbortable(
      destinationKeys(destination, canonicalKeyRequest),
      options.signal,
    );
    const previousWrites = Promise.all(
      reservedKeys.map((key) => pendingWrites.get(key) ?? Promise.resolve()),
    );
    const settled = new Promise<void>((resolve) => {
      releaseReservation = resolve;
    });
    reservation = settled;
    for (const key of reservedKeys) pendingWrites.set(key, settled);
    reservationRegistered = true;
    releaseAdmission();
    if (admissionTails.get(admissionScope) === currentAdmission) {
      admissionTails.delete(admissionScope);
    }
    await waitForAbortable(previousWrites, options.signal);
    const resolvedDestination = await waitForAbortable(destinationPromise, options.signal);
    const actualDestination = path.resolve(resolvedDestination);
    const actualKeys =
      actualDestination === path.resolve(destination)
        ? reservedKeys
        : await waitForAbortable(
            destinationKeys(actualDestination, canonicalKeys(actualDestination)),
            options.signal,
          );
    // A shared lexical or inode key already protects this write from aliases.
    // Avoid extending a held reservation with a second key: another alias may
    // have reserved that key while waiting on ours, which would form a cycle.
    const sharesKey = actualKeys.some((key) => reservedKeys.includes(key));
    const missingKeys = sharesKey ? [] : actualKeys.filter((key) => !reservedKeys.includes(key));
    if (missingKeys.length > 0) {
      const previousActualWrites = Promise.all(
        missingKeys.map((key) => pendingWrites.get(key) ?? Promise.resolve()),
      );
      for (const key of missingKeys) pendingWrites.set(key, settled);
      reservedKeys = [...reservedKeys, ...missingKeys];
      await waitForAbortable(previousActualWrites, options.signal);
    }
    return await write(actualDestination);
  } finally {
    if (options.signal?.aborted && canonicalKeyRequest) {
      discardCanonicalKey(destination, canonicalKeyRequest);
    }
    releaseAdmission();
    if (admissionTails.get(admissionScope) === currentAdmission) {
      admissionTails.delete(admissionScope);
    }
    if (reservationRegistered && releaseReservation) {
      releaseReservation();
      for (const key of reservedKeys) {
        if (pendingWrites.get(key) === reservation) pendingWrites.delete(key);
      }
    }
  }
}
