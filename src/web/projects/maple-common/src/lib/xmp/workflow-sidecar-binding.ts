import { PRIMARY_VARIANT_ID } from '../generated/workflow.generated';

/** Frozen HTTP source identity: retries cannot follow the editor's selection (#4063). */
export interface WorkflowSidecarBinding {
  readonly path: string;
  readonly variantId: string;
}

/** Preserve primary cache keys; a filesystem path cannot contain the separator. */
export function workflowSidecarKey(path: string, variantId = PRIMARY_VARIANT_ID): string {
  return variantId === PRIMARY_VARIANT_ID ? path : path + '\0' + variantId;
}
