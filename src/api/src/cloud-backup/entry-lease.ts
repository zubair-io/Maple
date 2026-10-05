import type { BackupRepository, BackupDestination, BackupEntry } from './repository.ts';

/** Renew independently of file hashing/readback, and abort a fenced transfer. */
export function startEntryLease(
  repo: BackupRepository,
  destination: BackupDestination,
  initial: BackupEntry,
  owner: string,
  parentSignal?: AbortSignal,
) {
  const controller = new AbortController();
  const signal = parentSignal
    ? AbortSignal.any([parentSignal, controller.signal])
    : controller.signal;
  let entry = initial;
  let renewing = false;
  const heartbeat = setInterval(() => {
    if (renewing) return;
    renewing = true;
    void repo
      .fence(entry, destination, owner)
      .then((valid) => {
        if (!valid) controller.abort(new Error('Backup lease or configuration changed'));
      })
      .catch(() => controller.abort(new Error('Backup lease renewal failed')))
      .finally(() => {
        renewing = false;
      });
  }, 20_000);
  return {
    signal,
    update: (value: BackupEntry) => {
      entry = value;
    },
    stop: () => clearInterval(heartbeat),
  };
}
