/** Protect workflow metadata through ordinary sidecar writes (#4036 / #4051). */
import { callNative } from 'maple';
import {
  parseSidecarWorkflow,
  PRIMARY_VARIANT_ID,
  WORKFLOW_MARKUP_PATTERN,
} from '../generated/workflow.generated';

async function primaryRecord(xml: string | null): Promise<string | null> {
  if (!xml || !new RegExp(WORKFLOW_MARKUP_PATTERN, 'u').test(xml)) return null;
  const read = await callNative('workflowReadXmp', [xml]);
  if (!read.ok) throw Error(read.error);
  if (read.value === 'null') return null;
  if (parseSidecarWorkflow(JSON.parse(read.value)).variantId !== PRIMARY_VARIANT_ID)
    throw Error('Variant identity does not match the primary sidecar.');
  return read.value;
}

export async function prepareWorkflowWrite(existing: string | null, next: string): Promise<string> {
  const retained = await primaryRecord(existing);
  await primaryRecord(next);
  if (retained === null) return next;
  const checkpoint = await callNative('workflowCheckpointXmp', [next]);
  if (!checkpoint.ok) throw Error(checkpoint.error);
  const preserved = await callNative('workflowEmbedXmp', [retained, checkpoint.value]);
  if (!preserved.ok) throw Error(preserved.error);
  return preserved.value;
}
