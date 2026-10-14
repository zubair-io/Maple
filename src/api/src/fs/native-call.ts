import { callNative, getMapleConcurrency, MapleWorkerPoolOverloadedError } from 'maple';

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

interface WaitingCall {
  method: string;
  args: string[];
  signal?: AbortSignal;
  deadline: number;
  delayMs: number;
  lastOverload: unknown;
  resolve: (value: { ok: true; value: string } | { ok: false; error: string }) => void;
  reject: (error: Error) => void;
  settled: boolean;
  onAbort?: () => void;
}

const MAX_WAITING_CALLS = 32;
const RETRY_DEADLINE_MS = 60_000;
const waitingCalls: WaitingCall[] = [];
const activeRetries = new Set<WaitingCall>();
let draining = false;

function abortError(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason;
  const error = new Error(
    typeof signal.reason === 'string' ? signal.reason : 'Native call aborted.',
  );
  error.name = 'AbortError';
  return error;
}

function callWithAbort(
  call: WorkflowCall,
  method: string,
  args: string[],
  signal?: AbortSignal,
): Promise<{ ok: true; value: string } | { ok: false; error: string }> {
  if (!signal) return call(method, args);
  if (signal.aborted) return Promise.reject(abortError(signal));
  return call(method, args).then(
    (value) => {
      if (signal.aborted) throw abortError(signal);
      return value;
    },
    (error: unknown) => {
      if (signal.aborted) throw abortError(signal);
      throw error;
    },
  );
}

function waitForRetry(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (!signal) return new Promise((resolve) => setTimeout(resolve, milliseconds));
  if (signal.aborted) return Promise.resolve();
  let timer: ReturnType<typeof setTimeout>;
  const delay = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, milliseconds);
  });
  const cleanup = new AbortController();
  const aborted = new Promise<void>((resolve) => {
    signal.addEventListener('abort', () => resolve(), {
      once: true,
      signal: cleanup.signal,
    });
  });
  return Promise.race([delay, aborted]).finally(() => {
    clearTimeout(timer);
    cleanup.abort();
  });
}

function removeWaitingCall(item: WaitingCall): void {
  const index = waitingCalls.indexOf(item);
  if (index >= 0) waitingCalls.splice(index, 1);
  if (item.signal && item.onAbort) item.signal.removeEventListener('abort', item.onAbort);
}

function rejectWaitingCall(item: WaitingCall, error: unknown): void {
  if (item.settled) return;
  item.settled = true;
  removeWaitingCall(item);
  item.reject(error instanceof Error ? error : new Error(String(error)));
  drainWaitingCalls();
}

function resolveWaitingCall(
  item: WaitingCall,
  value: { ok: true; value: string } | { ok: false; error: string },
): void {
  if (item.settled) return;
  item.settled = true;
  removeWaitingCall(item);
  item.resolve(value);
}

function enqueueRetry(
  method: string,
  args: string[],
  signal: AbortSignal | undefined,
  initialOverload: unknown,
): Promise<{ ok: true; value: string } | { ok: false; error: string }> {
  if (signal?.aborted) return Promise.reject(abortError(signal));
  if (waitingCalls.length >= MAX_WAITING_CALLS)
    return Promise.reject(new MapleWorkerPoolOverloadedError());

  return new Promise((resolve, reject) => {
    const item: WaitingCall = {
      method,
      args,
      signal,
      deadline: performance.now() + RETRY_DEADLINE_MS,
      delayMs: 5,
      lastOverload: initialOverload,
      resolve,
      reject,
      settled: false,
    };
    if (signal) {
      item.onAbort = () => {
        rejectWaitingCall(item, abortError(signal));
      };
      signal.addEventListener('abort', item.onAbort, { once: true });
    }
    waitingCalls.push(item);
    drainWaitingCalls();
  });
}

async function retryWaitingCall(call: WorkflowCall, item: WaitingCall): Promise<void> {
  while (!item.settled) {
    if (item.signal?.aborted) {
      rejectWaitingCall(item, abortError(item.signal));
      return;
    }
    const remaining = item.deadline - performance.now();
    if (remaining <= 0) {
      rejectWaitingCall(item, item.lastOverload);
      return;
    }
    try {
      const result = await callWithAbort(call, item.method, item.args, item.signal);
      resolveWaitingCall(item, result);
      return;
    } catch (error) {
      if (item.settled) return;
      if (!isPoolOverload(error)) {
        rejectWaitingCall(item, error);
        return;
      }
      item.lastOverload = error;
      const delay = Math.min(item.delayMs, item.deadline - performance.now());
      item.delayMs = Math.min(item.delayMs * 2, 100);
      await waitForRetry(delay, item.signal);
    }
  }
}

function drainWaitingCalls(): void {
  if (draining) return;
  draining = true;
  const call = callNative as unknown as WorkflowCall;
  try {
    const concurrency = getMapleConcurrency();
    while (activeRetries.size < concurrency) {
      const item = waitingCalls.find((candidate) => !activeRetries.has(candidate));
      if (!item) break;
      activeRetries.add(item);
      void retryWaitingCall(call, item).finally(() => {
        activeRetries.delete(item);
        drainWaitingCalls();
      });
    }
  } finally {
    draining = false;
  }
}

export async function callNativeRetrying(
  method: string,
  args: string[],
  signal?: AbortSignal,
): Promise<{ ok: true; value: string } | { ok: false; error: string }> {
  const call = callNative as unknown as WorkflowCall;
  if (signal?.aborted) throw abortError(signal);
  if (waitingCalls.length > 0)
    return enqueueRetry(method, args, signal, new MapleWorkerPoolOverloadedError());
  try {
    return await callWithAbort(call, method, args, signal);
  } catch (error) {
    if (!isPoolOverload(error) || signal?.aborted) throw error;
    return enqueueRetry(method, args, signal, error);
  }
}
