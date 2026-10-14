import { callNative } from 'maple';

export function isPoolOverload(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const e = error as { code?: unknown; name?: unknown; message?: unknown };
  return (
    e.code === 'MAPLE_WORKER_POOL_OVERLOADED' ||
    e.name === 'MapleWorkerPoolOverloadedError' ||
    (typeof e.message === 'string' && e.message.includes('worker pool is full'))
  );
}

type WorkflowCall = (
  method: string,
  args: string[],
) => Promise<{ ok: true; value: string } | { ok: false; error: string }>;

export async function callNativeRetrying(
  method: string,
  args: string[],
): Promise<{ ok: true; value: string } | { ok: false; error: string }> {
  const call = callNative as unknown as WorkflowCall;
  const deadlineMs = Date.now() + 60_000;
  let delayMs = 5;
  for (;;) {
    try {
      return await call(method, args);
    } catch (error) {
      if (!isPoolOverload(error) || Date.now() >= deadlineMs) throw error;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      delayMs = Math.min(delayMs * 2, 100);
    }
  }
}
