import type { RegisterPending } from './raw-pipeline.dispatch-with-mark';
import { dispatchWithMark } from './raw-pipeline.dispatch-with-mark';
import type { ResolveImportedWbRequest } from './raw-pipeline.types';

export interface ImportedWhiteBalancePair {
  readonly temperature: number;
  readonly tint: number;
}

/** Ask the retained session for its name-only imported Auto WB pair (#4669). */
export function dispatchResolveImportedWb(
  worker: Worker,
  id: number,
  register: RegisterPending,
): Promise<ImportedWhiteBalancePair> {
  const request: ResolveImportedWbRequest = { id, type: 'resolve-imported-wb' };
  return dispatchWithMark<ImportedWhiteBalancePair>(
    worker,
    request,
    [],
    'maple:resolve-imported-wb',
    ({ resolve, reject }) => ({ kind: 'resolve-imported-wb', resolve, reject }),
    register,
  );
}
