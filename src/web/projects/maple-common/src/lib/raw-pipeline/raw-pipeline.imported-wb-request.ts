import type { RegisterPending } from './raw-pipeline.dispatch-with-mark';
import { dispatchWithMark } from './raw-pipeline.dispatch-with-mark';
import type { ImportedWbSession, ResolveImportedWbRequest } from './raw-pipeline.imported-wb.types';

export interface ImportedWhiteBalancePair {
  readonly temperature: number;
  readonly tint: number;
}

/** Ask `session` for its name-only imported Auto WB pair (#4669). No session
 *  holds the caller's photo any more → reject without reaching the worker. */
function dispatchResolveImportedWb(
  worker: Worker,
  id: number,
  register: RegisterPending,
  session: ImportedWbSession | null,
): Promise<ImportedWhiteBalancePair> {
  if (!session) {
    return Promise.reject(new Error('resolve-imported-wb: no worker session holds this photo'));
  }
  const request: ResolveImportedWbRequest = { id, type: 'resolve-imported-wb', session };
  return dispatchWithMark<ImportedWhiteBalancePair>(
    worker,
    request,
    [],
    'maple:resolve-imported-wb',
    ({ resolve, reject }) => ({ kind: 'resolve-imported-wb', resolve, reject }),
    register,
  );
}

/** One resolve per worker session (#4669). Name-only Auto can become active on
 *  an open photo more than once (cold open, a variant, a history restore): each
 *  later ask joins the session's request, and a failed estimate is not run
 *  again on every edit. A new session (another open) asks again. */
export class ImportedWbRequests {
  private last: { session: string; pair: Promise<ImportedWhiteBalancePair> } | null = null;

  request(
    worker: Worker,
    id: number,
    register: RegisterPending,
    session: ImportedWbSession | null,
  ): Promise<ImportedWhiteBalancePair> {
    const key = session && `${session.kind}:${session.token}`;
    if (key && this.last?.session === key) return this.last.pair;
    const pair = dispatchResolveImportedWb(worker, id, register, session);
    if (key) this.last = { session: key, pair };
    return pair;
  }
}
