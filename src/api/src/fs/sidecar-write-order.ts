/** One sequencing barrier for actual writes to a canonical allowed sidecar path (#4051). */
import { traceSidecar } from './sidecar-write-chronology';
const moduleInstance = crypto.randomUUID();
let transactionSequence = 0;
const pendingWrites = new Map<string, Promise<void>>();
export async function serializeSidecarWrite<T>(
  destination: string,
  write: () => Promise<T>,
): Promise<T> {
  const previous = pendingWrites.get(destination) ?? Promise.resolve();
  const transaction = ++transactionSequence;
  traceSidecar('queued', {
    destination,
    moduleInstance,
    moduleUrl: import.meta.url,
    transaction,
    hasPrevious: pendingWrites.has(destination),
  });
  const next = previous.then(async () => {
    traceSidecar('enter', { destination, moduleInstance, transaction });
    try {
      return await write();
    } finally {
      traceSidecar('leave', { destination, moduleInstance, transaction });
    }
  });
  const settled = next.then(
    () => undefined,
    () => undefined,
  );
  pendingWrites.set(destination, settled);
  return next.finally(() => {
    if (pendingWrites.get(destination) === settled) pendingWrites.delete(destination);
  });
}
