import { InjectionToken } from '@angular/core';
import type { Observable } from 'rxjs';
import type { SidecarWorkflow } from '../generated/workflow.generated';
import type { WorkflowVariantSidecar } from '../xmp/workflow-variant-store.service';

/** Self Hosted discovery/create port; Hosted uses its real filesystem store (#4063). */
export interface WorkflowVariantServer {
  list(path: string): Observable<WorkflowVariantSidecar[]>;
  create(
    path: string,
    workflow: SidecarWorkflow,
    sourceVariantId: string,
  ): Observable<WorkflowVariantSidecar>;
}

export const WORKFLOW_VARIANT_SERVER = new InjectionToken<WorkflowVariantServer>(
  'WORKFLOW_VARIANT_SERVER',
);
