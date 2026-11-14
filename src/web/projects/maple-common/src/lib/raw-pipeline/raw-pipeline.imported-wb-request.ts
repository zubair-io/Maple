import type { RegisterPending } from './raw-pipeline.dispatch-with-mark';
import { dispatchWithMark } from './raw-pipeline.dispatch-with-mark';
import type { ImportedWbSession, ResolveImportedWbRequest } from './raw-pipeline.imported-wb.types';
import type { SampleQueue } from './raw-pipeline.samplers';

export interface ImportedWhiteBalancePair {
  readonly temperature: number;
  readonly tint: number;
}

/** How long the editor must post nothing to the worker before an estimate
 *  starts: past the refine pass that follows a slider's last tick. */
export const IMPORTED_WB_IDLE_MS = 400;

/** One attempt on `session`; resolves null when the estimate was cancelled. */
function dispatchResolveImportedWb(
  worker: Worker,
  id: number,
  register: RegisterPending,
  session: ImportedWbSession,
): Promise<ImportedWhiteBalancePair | null> {
  const request: ResolveImportedWbRequest = { id, type: 'resolve-imported-wb', session };
  return dispatchWithMark<ImportedWhiteBalancePair | null>(
    worker,
    request,
    [],
    'maple:resolve-imported-wb',
    ({ resolve, reject }) => ({ kind: 'resolve-imported-wb', resolve, reject }),
    register,
  );
}

const sessionKey = (session: ImportedWbSession | null): string | null =>
  session && `${session.kind}:${session.token}`;

/**
 * One resolve per worker session (#4669). Name-only Auto can become active on
 * an open photo more than once (cold open, a variant, a history restore): each
 * later ask joins the session's request, and a failed estimate is not run
 * again on every edit. A new session (another open) asks again.
 *
 * The estimate is a synchronous wasm call on the render worker, so it starts
 * only once the editor has been idle for {@link IMPORTED_WB_IDLE_MS}, and
 * {@link preempt} cancels it through the worker's shared cancel flag before any
 * other request reaches the worker (#5923). A cancelled estimate keeps nothing
 * and starts again at the next idle moment while its session is still open.
 * Without the flag (a page that is not cross-origin isolated) a request posted
 * during the estimate waits for it.
 */
export class ImportedWbRequests {
  private last: { session: string; pair: Promise<ImportedWhiteBalancePair> } | null = null;
  private cancelFlag: Uint8Array | null = null;
  private inFlight = false;
  private lastPost = Number.NEGATIVE_INFINITY;

  adoptCancelFlag(flag: Uint8Array): void {
    this.cancelFlag = flag;
  }

  /** Every other request passes its worker through here before posting. */
  preempt<T>(worker: T): T {
    this.lastPost = performance.now();
    if (this.inFlight && this.cancelFlag) Atomics.store(this.cancelFlag, 0, 1);
    return worker;
  }

  /** `current` names the session holding the photo now (null once none does);
   *  `dispatch` posts each attempt on it. */
  request(
    current: () => ImportedWbSession | null,
    dispatch: SampleQueue,
  ): Promise<ImportedWhiteBalancePair> {
    const key = sessionKey(current());
    if (!key) {
      return Promise.reject(new Error('resolve-imported-wb: no worker session holds this photo'));
    }
    if (this.last?.session === key) return this.last.pair;
    const pair = this.settle(key, current, (session) =>
      dispatch((worker, id, register) => dispatchResolveImportedWb(worker, id, register, session)),
    );
    this.last = { session: key, pair };
    return pair;
  }

  private async settle(
    key: string,
    current: () => ImportedWbSession | null,
    send: (session: ImportedWbSession) => Promise<ImportedWhiteBalancePair | null>,
  ): Promise<ImportedWhiteBalancePair> {
    for (;;) {
      await this.idle();
      const session = current();
      if (sessionKey(session) !== key || !session) {
        throw new Error(`resolve-imported-wb: ${key} is no longer open`);
      }
      if (this.cancelFlag) Atomics.store(this.cancelFlag, 0, 0);
      const reply = send(session);
      this.inFlight = true;
      const pair = await reply.finally(() => (this.inFlight = false));
      if (pair) return pair;
    }
  }

  private idle(): Promise<void> {
    return new Promise((resolve) => {
      const check = (): void => {
        const quiet = performance.now() - this.lastPost;
        if (quiet >= IMPORTED_WB_IDLE_MS) resolve();
        else setTimeout(check, IMPORTED_WB_IDLE_MS - quiet);
      };
      check();
    });
  }
}
