import type { RegisterPending } from './raw-pipeline.dispatch-with-mark';
import { dispatchWithMark } from './raw-pipeline.dispatch-with-mark';
import type { ImportedWbSession, ResolveImportedWbRequest } from './raw-pipeline.imported-wb.types';

export interface ImportedWhiteBalancePair {
  readonly temperature: number;
  readonly tint: number;
}

/** Ask `session` for its name-only imported Auto WB pair (#4669). No session
 *  holds the caller's photo any more → reject without reaching the worker. */
export function dispatchResolveImportedWb(
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
