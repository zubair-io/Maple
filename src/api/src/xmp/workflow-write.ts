/** Protect workflow metadata through ordinary sidecar writes (#4036). */
import { callNative } from 'maple';
import { WORKFLOW_MARKUP_PATTERN } from '../generated/workflow.generated';

export async function prepareWorkflowWrite(existing: string | null, next: string): Promise<string> {
  const hasWorkflow = (xml: string) => new RegExp(WORKFLOW_MARKUP_PATTERN, 'u').test(xml);
  const oldRecord =
    existing && hasWorkflow(existing) ? await callNative('workflowReadXmp', [existing]) : null;
  if (oldRecord && !oldRecord.ok) throw new Error(oldRecord.error);
  if (hasWorkflow(next)) {
    const validated = await callNative('workflowReadXmp', [next]);
    if (!validated.ok) throw new Error(validated.error);
    return next;
  }
  if (oldRecord?.ok && oldRecord.value !== 'null') {
    const preserved = await callNative('workflowEmbedXmp', [oldRecord.value, next]);
    if (!preserved.ok) throw new Error(preserved.error);
    return preserved.value;
  }
  return next;
}
