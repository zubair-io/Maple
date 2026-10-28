/**
 * A stitch request that repeats the one already running (#5488).
 *
 * A client whose POST was accepted but whose response was lost — a phone
 * dropping off the LAN mid-request, then retrying via the server's public
 * URL — sends the same request again. Answering that with the running job's id
 * lets it watch and cancel its own stitch; answering 409 would strand it, since
 * it never learnt the id. Any other request still meets the one-stitch limit.
 */
import type { JobWithId } from '../db/schema.ts';

export interface StitchIdentity {
  assetIds: readonly string[];
  libraryId: string;
  retention: string;
  localAlign: string;
  strategy: string | null;
}

const sortedKey = (ids: readonly unknown[]): string => JSON.stringify([...ids].map(String).sort());

export function repeatsRunningStitch(active: JobWithId, next: StitchIdentity): boolean {
  const running = active.payload;
  return (
    Array.isArray(running.assetIds) &&
    sortedKey(running.assetIds) === sortedKey(next.assetIds) &&
    running.libraryId === next.libraryId &&
    running.retention === next.retention &&
    running.localAlign === next.localAlign &&
    (running.strategy ?? null) === next.strategy
  );
}
