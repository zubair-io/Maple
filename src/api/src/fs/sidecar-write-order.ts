/** One sequencing barrier for actual writes to a canonical allowed sidecar path (#4051). */
const pendingWrites = new Map<string, Promise<void>>();
export async function serializeSidecarWrite<T>(
  destination: string,
  write: () => Promise<T>,
): Promise<T> {
  const previous = pendingWrites.get(destination) ?? Promise.resolve();
  const next = previous.then(write);
  const settled = next.then(
    () => undefined,
    () => undefined,
  );
  pendingWrites.set(destination, settled);
  return next.finally(() => {
    if (pendingWrites.get(destination) === settled) pendingWrites.delete(destination);
  });
}
