import type { PendingRequest } from './ffi-pool-slots.ts';
import {
  estimateDecodeCost,
  type DecodeCost,
  type DecodeMemoryBudget,
  type ReleaseReservation,
} from './decode-memory-budget.ts';

/** The request with its reservation released exactly once, however it settles:
 * a reply, a mismatched reply (the slot pool then calls `onError`), a child
 * crash, a post failure or shutdown. */
function releasingOnSettle(req: PendingRequest, release: ReleaseReservation): PendingRequest {
  return {
    ...req,
    onResponse: (msg) => {
      const handled = req.onResponse(msg);
      if (handled) release();
      return handled;
    },
    onError: (err) => {
      release();
      req.onError(err);
    },
  };
}

function asError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}

/** Reserve the request's estimated peak, then hand it to `enqueue`. A request
 * larger than the whole budget is rejected without ever reaching a child. */
export async function admitDecode(
  budget: DecodeMemoryBudget,
  cost: DecodeCost,
  req: PendingRequest,
  enqueue: (req: PendingRequest) => void,
): Promise<void> {
  const release = await estimateDecodeCost(cost)
    .then((bytes) => budget.acquire(bytes))
    .catch((err: unknown) => {
      req.onError(asError(err));
      return null;
    });
  if (!release) return;
  const admitted = releasingOnSettle(
    { ...req, retireWorkerAfter: cost.weight === 'develop' },
    release,
  );
  try {
    enqueue(admitted);
  } catch (err) {
    admitted.onError(asError(err));
  }
}
