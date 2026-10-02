/** #1472: saves and conflict copies share relocation's canonical XMP lock. */
import * as fs from './mirrored.ts';
import { dirname } from 'node:path';
import { safeWriteAllowed } from './root.ts';
import { xmpSidecarPath } from './xmp.ts';
import { removalRelocationLease } from './removal-relocation-lease.ts';
import { assertRemovalRecovered, recoverRemovalRelocation } from './removal-relocation-journal.ts';

const pending = new Map<string, Promise<void>>();

export async function withSidecarMutationLease<T>(
  raw: string,
  mutation: () => Promise<T>,
): Promise<T> {
  const sidecar = xmpSidecarPath(raw);
  const allowed = await safeWriteAllowed(sidecar);
  if (!allowed.ok) throw new Error(allowed.error ?? 'Path not allowed');
  // This server's relocation recovery is POSIX-only. Keep ordinary metadata
  // writes on other hosts working, but never write over a transported pending
  // removal journal: its recovery call fails closed on an unsupported host.
  if (process.platform !== 'darwin' && process.platform !== 'linux') {
    await recoverRemovalRelocation(raw);
    return mutation();
  }
  // Serialize requests in this server; a different process or native editor
  // still has to grant the kernel lease. Hold it across the precondition read
  // and every conflict-copy mutation, not just the final canonical rename.
  const previous = pending.get(sidecar);
  let unlock!: () => void;
  const gate = new Promise<void>((resolve) => {
    unlock = resolve;
  });
  pending.set(sidecar, gate);
  try {
    await previous;
    await fs.mkdir(dirname(sidecar), { recursive: true });
    await recoverRemovalRelocation(raw);
    const lease = await removalRelocationLease(raw, raw);
    try {
      await assertRemovalRecovered(raw);
      return await mutation();
    } finally {
      await lease.release();
    }
  } finally {
    unlock();
    if (pending.get(sidecar) === gate) pending.delete(sidecar);
  }
}
