/** Scoped admission and canonical-path sequencing for sidecar writes (#4051). */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { resolveRealPath } from './root.ts';

const pendingWrites = new Map<string, Promise<void>>();
const inFlightKeys = new Map<string, Promise<string[]>>();
const admissionTails = new Map<string, Promise<void>>();

/** A route may bind a queued write to the primary and catalog location it read. */
export type SidecarWriteScope =
  | string
  | {
      directory: string;
      validate(): Promise<void>;
    };

export interface SidecarWriteOrderOptions {
  /**
   * Canonical library root used to keep slow destination checks from blocking
   * other libraries. Omitted scopes share one conservative lane because
   * lexical parent paths alone cannot distinguish symlink aliases.
   */
  admissionScope?: SidecarWriteScope;
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

function isMissingPathError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error.code === 'ENOENT' || error.code === 'ENOTDIR')
  );
}

function canonicalKeys(destination: string, allowMissingParent: boolean): Promise<string[]> {
  const cacheKey = JSON.stringify([destination, allowMissingParent]);
  const existing = inFlightKeys.get(cacheKey);
  if (existing) return existing;
  const pending = (async () => {
    const lexicalDestination = path.resolve(destination);
    const resolvedDestination = await resolveRealPath(lexicalDestination).catch(
      (error: unknown) => {
        if (isMissingPathError(error)) return null;
        throw error;
      },
    );
    const canonicalDestination =
      resolvedDestination ??
      path.join(
        await resolveRealPath(path.dirname(lexicalDestination)).catch((error: unknown) => {
          if (isMissingPathError(error)) {
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
    // A missing parent may be an invalid destination whose resolver will reject
    // it. Keep its lexical key reserved until that validation finishes. Direct
    // writes still require a real parent; other stat failures always surface.
    const parentStat = await fs.stat(parent, { bigint: true }).catch((error: unknown) => {
      if (allowMissingParent && isMissingPathError(error)) return null;
      throw error;
    });
    return [
      lexicalKey(canonicalDestination),
      ...(parentStat ? [`inode:${parentStat.dev}:${parentStat.ino}:${basename}`] : []),
    ];
  })();
  inFlightKeys.set(cacheKey, pending);
  void pending.then(
    () => {
      if (inFlightKeys.get(cacheKey) === pending) inFlightKeys.delete(cacheKey);
    },
    () => {
      if (inFlightKeys.get(cacheKey) === pending) inFlightKeys.delete(cacheKey);
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

function discardCanonicalKey(
  destination: string,
  pending: Promise<string[]>,
  allowMissingParent: boolean,
): void {
  const cacheKey = JSON.stringify([destination, allowMissingParent]);
  if (inFlightKeys.get(cacheKey) === pending) inFlightKeys.delete(cacheKey);
}

interface WriteAdmission {
  previous: Promise<void>;
  acquired: boolean;
  release(): void;
  releaseAfterPrevious(): void;
}

function reserveAdmission(scope: string): WriteAdmission {
  const previous = admissionTails.get(scope) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  admissionTails.set(scope, current);
  let released = false;
  const releaseCurrent = () => {
    if (released) return;
    released = true;
    release();
    if (admissionTails.get(scope) === current) admissionTails.delete(scope);
  };
  return {
    previous,
    acquired: false,
    release: releaseCurrent,
    releaseAfterPrevious: () => void previous.then(releaseCurrent, releaseCurrent),
  };
}

interface WriteReservation {
  keys: string[];
  barrier: Promise<void>;
  prerequisites: Promise<void>;
  release: () => void;
}

function registerReservation(keys: string[]): {
  reservation: WriteReservation;
  previousWrites: Promise<void[]>;
} {
  const previousWrites = Promise.all(
    keys.map((key) => pendingWrites.get(key) ?? Promise.resolve()),
  );
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  const reservation = {
    keys: [...keys],
    barrier,
    prerequisites: previousWrites.then(() => undefined),
    release,
  };
  for (const key of keys) pendingWrites.set(key, barrier);
  return { reservation, previousWrites };
}

function extendReservation(reservation: WriteReservation, missingKeys: string[]): Promise<void[]> {
  const previousWrites = Promise.all(
    missingKeys.map((key) => pendingWrites.get(key) ?? Promise.resolve()),
  );
  reservation.prerequisites = Promise.all([
    reservation.prerequisites,
    previousWrites.then(() => undefined),
  ]).then(() => undefined);
  for (const key of missingKeys) pendingWrites.set(key, reservation.barrier);
  reservation.keys = [...reservation.keys, ...missingKeys];
  return previousWrites;
}

interface HeldReservation {
  reservation: WriteReservation;
  previousWrites: Promise<unknown>;
}

/**
 * Add `keys` to a reservation whose earlier keys are already settled. When
 * another reservation holds one of the new keys, waiting on it while keeping
 * the first set is hold-and-wait: that holder may be queued behind this
 * reservation's first keys (a name that became an alias after it reserved).
 * The write has not run yet, so release everything and register the union
 * afresh, behind every current holder.
 */
function reserveAdditionalKeys(reservation: WriteReservation, keys: string[]): HeldReservation {
  const sharesKey = keys.some((key) => reservation.keys.includes(key));
  const missingKeys = sharesKey ? [] : keys.filter((key) => !reservation.keys.includes(key));
  if (missingKeys.length === 0) return { reservation, previousWrites: Promise.resolve() };
  if (!missingKeys.some((key) => pendingWrites.has(key))) {
    return { reservation, previousWrites: extendReservation(reservation, missingKeys) };
  }
  releaseReservation(reservation, true);
  return registerReservation([...reservation.keys, ...missingKeys]);
}

function releaseReservation(reservation: WriteReservation, waitForPrerequisites: boolean): void {
  const release = () => {
    reservation.release();
    for (const key of reservation.keys) {
      if (pendingWrites.get(key) === reservation.barrier) pendingWrites.delete(key);
    }
  };
  if (waitForPrerequisites) {
    void reservation.prerequisites.then(release, release);
  } else {
    release();
  }
}

async function reserveActualDestinationKeys(
  destination: string,
  resolvedDestination: string,
  allowMissingParent: boolean,
  reservation: WriteReservation,
  signal?: AbortSignal,
): Promise<HeldReservation> {
  const actualDestination = path.resolve(resolvedDestination);
  if (actualDestination === path.resolve(destination)) {
    return { reservation, previousWrites: Promise.resolve() };
  }

  const actualCanonicalKeyRequest = canonicalKeys(actualDestination, allowMissingParent);
  let actualKeys: string[];
  try {
    actualKeys = await waitForAbortable(
      destinationKeys(actualDestination, actualCanonicalKeyRequest),
      signal,
    );
  } catch (error) {
    if (signal?.aborted) {
      discardCanonicalKey(actualDestination, actualCanonicalKeyRequest, allowMissingParent);
    }
    throw error;
  }
  return reserveAdditionalKeys(reservation, actualKeys);
}

async function validateWriteScope(
  scope: SidecarWriteScope | undefined,
  signal?: AbortSignal,
): Promise<void> {
  if (typeof scope === 'object') await waitForAbortable(scope.validate(), signal);
  signal?.throwIfAborted();
}

/**
 * One save barrier over several sidecars, reserving every name's keys at once.
 * Nesting `serializeSidecarWrite` calls instead would hold one key set while
 * waiting on the next, and no path order matches the key sets: a file symlink
 * or a second mount path reaches one sidecar under a different name.
 */
export async function serializeSidecarWrites<T>(
  destinations: readonly string[],
  write: () => Promise<T>,
  options: SidecarWriteOrderOptions = {},
): Promise<T> {
  const admission = reserveAdmission('\0unscoped');
  let reservation: WriteReservation | undefined;
  try {
    await waitForAbortable(admission.previous, options.signal);
    admission.acquired = true;
    const keySets = await Promise.all(
      destinations.map((destination) =>
        destinationKeys(destination, canonicalKeys(destination, false)),
      ),
    );
    const registered = registerReservation([...new Set(keySets.flat())]);
    reservation = registered.reservation;
    admission.release();
    await waitForAbortable(registered.previousWrites, options.signal);
    await validateWriteScope(options.admissionScope, options.signal);
    return await write();
  } finally {
    if (options.signal?.aborted && !admission.acquired) admission.releaseAfterPrevious();
    else admission.release();
    if (reservation) releaseReservation(reservation, options.signal?.aborted === true);
  }
}

/** Claim a newly chosen conflict name without waiting while holding source
 * sidecars. A busy destination must be retried by the caller; waiting could
 * deadlock with a multi-path relocate already queued behind the source. */
export async function trySerializeSidecarWrite<T>(
  destination: string,
  write: () => Promise<T>,
): Promise<{ acquired: false } | { acquired: true; value: T }> {
  const admission = reserveAdmission('\0unscoped');
  let reservation: WriteReservation | undefined;
  try {
    await admission.previous;
    const keys = await destinationKeys(destination, canonicalKeys(destination, false));
    if (keys.some((key) => pendingWrites.has(key))) return { acquired: false };
    const registered = registerReservation(keys);
    reservation = registered.reservation;
    admission.release();
    return { acquired: true, value: await write() };
  } finally {
    admission.release();
    if (reservation) releaseReservation(reservation, false);
  }
}

export async function serializeSidecarWrite<T>(
  destination: string,
  write: (resolvedDestination: string) => Promise<T>,
  options: SidecarWriteOrderOptions = {},
): Promise<T> {
  // Keep admission ordered within a library, while reserving canonical path
  // keys before potentially slow authorization. This lets aliases queue in
  // arrival order without making unrelated libraries wait for path checks.
  const scope =
    typeof options.admissionScope === 'object'
      ? options.admissionScope.directory
      : options.admissionScope;
  const admissionScope =
    scope === undefined
      ? '\0unscoped'
      : path.resolve(scope).normalize('NFC').toLowerCase().normalize('NFC');
  const admission = reserveAdmission(admissionScope);
  let canonicalKeyRequest: Promise<string[]> | undefined;
  let reservation: WriteReservation | undefined;
  const destinationPromise = Promise.resolve().then(
    () => options.resolveDestination?.() ?? destination,
  );
  void destinationPromise.catch(() => undefined);

  try {
    await waitForAbortable(admission.previous, options.signal);
    admission.acquired = true;
    canonicalKeyRequest = canonicalKeys(destination, options.resolveDestination !== undefined);
    void canonicalKeyRequest.catch(() => undefined);
    const reservedKeys = await waitForAbortable(
      destinationKeys(destination, canonicalKeyRequest),
      options.signal,
    );
    const registered = registerReservation(reservedKeys);
    reservation = registered.reservation;
    admission.release();
    await waitForAbortable(registered.previousWrites, options.signal);
    const resolvedDestination = await waitForAbortable(destinationPromise, options.signal);
    // A shared lexical or inode key already protects this write from aliases;
    // otherwise the resolved name's keys are added without hold-and-wait.
    const actual = await reserveActualDestinationKeys(
      destination,
      resolvedDestination,
      options.resolveDestination !== undefined,
      reservation,
      options.signal,
    );
    reservation = actual.reservation;
    await waitForAbortable(actual.previousWrites, options.signal);
    await validateWriteScope(options.admissionScope, options.signal);
    return await write(path.resolve(resolvedDestination));
  } finally {
    if (options.signal?.aborted && canonicalKeyRequest) {
      discardCanonicalKey(
        destination,
        canonicalKeyRequest,
        options.resolveDestination !== undefined,
      );
    }
    if (options.signal?.aborted && !admission.acquired) {
      // A canceled waiter still holds its queue position. Releasing it before
      // its predecessor registers canonical keys can let a later alias pass
      // that predecessor and publish first.
      admission.releaseAfterPrevious();
    } else {
      admission.release();
    }
    if (reservation) releaseReservation(reservation, options.signal?.aborted === true);
  }
}
