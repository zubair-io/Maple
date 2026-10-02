/** Portable sibling storage; originals are never opened for writing (#4040). */
import * as path from 'node:path';
import { callNative } from 'maple';
import * as fs from './mirrored';
import { xmpSidecarPath } from './xmp';
import { serializeSidecarWrite } from './sidecar-write-order';
import { safeWriteAllowed } from './root';
import { writeSidecarAtomic, writeSidecarCreateOnly, isMissingSidecar } from './sidecar-io';
import {
  parseSidecarWorkflow,
  PRIMARY_VARIANT_ID,
  type SidecarWorkflow,
  type WorkflowHistoryEntry,
  type WorkflowSnapshot,
} from '../generated/workflow.generated';

export class WorkflowVariantError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
type VariantSidecar = {
  variantId: string;
  filename: string;
  workflow: SidecarWorkflow | null;
  exists: boolean;
};

async function nativeValue(
  method:
    | 'workflowReadXmp'
    | 'workflowEmbedXmp'
    | 'workflowVariantFilename'
    | 'workflowCheckpointXmp'
    | 'workflowCommitXmp'
    | 'workflowSnapshotXmp'
    | 'workflowRestoreXmp',
  args: [string] | [string, string],
): Promise<string> {
  const result = await callNative(method, args);
  if (!result.ok) throw new WorkflowVariantError(422, result.error);
  return result.value;
}
async function variantPath(rawPath: string, id: string): Promise<string> {
  const primary = xmpSidecarPath(rawPath);
  const filename = await nativeValue('workflowVariantFilename', [path.basename(primary), id]);
  const destination = path.join(path.dirname(primary), filename);
  const allowed = await safeWriteAllowed(destination);
  if (!allowed.ok) throw new WorkflowVariantError(403, allowed.error ?? 'Sidecar path not allowed');
  return allowed.data ?? destination;
}
async function record(xml: string): Promise<SidecarWorkflow | null> {
  const value: unknown = JSON.parse(await nativeValue('workflowReadXmp', [xml]));
  return value === null ? null : parseSidecarWorkflow(value);
}
function requireIdentity(value: SidecarWorkflow | null, id: string, filename: string): void {
  if ((value?.variantId ?? PRIMARY_VARIANT_ID) !== id)
    throw new WorkflowVariantError(
      422,
      `Variant identity does not match ${filename}. Repair the sidecar before editing.`,
    );
}
export async function readWorkflowVariant(rawPath: string, id: string): Promise<string | null> {
  const destination = await variantPath(rawPath, id);
  const xml = await fs.readFile(destination, 'utf8').catch((error: unknown) => {
    if (isMissingSidecar(error)) return null;
    throw error;
  });
  if (xml === null && id !== PRIMARY_VARIANT_ID)
    throw new WorkflowVariantError(
      404,
      `Variant sidecar is missing: ${path.basename(destination)}. Restore it before editing.`,
    );
  if (xml !== null) requireIdentity(await record(xml), id, path.basename(destination));
  return xml;
}
async function inspect(rawPath: string, id: string): Promise<VariantSidecar> {
  const destination = await variantPath(rawPath, id);
  const xml = await readWorkflowVariant(rawPath, id);
  return {
    variantId: id,
    filename: path.basename(destination),
    workflow: xml === null ? null : await record(xml),
    exists: xml !== null,
  };
}
export async function listWorkflowVariants(rawPath: string): Promise<VariantSidecar[]> {
  const primary = await variantPath(rawPath, PRIMARY_VARIANT_ID);
  const prefix = path.basename(primary, '.xmp') + '.v';
  const files = (await fs.readdir(path.dirname(primary))).sort();
  const candidates = files.filter((name) => name.startsWith(prefix) && name.endsWith('.xmp'));
  const ids = candidates
    .map((name) => name.slice(prefix.length, -4))
    .filter((id) => id.length === 36);
  return Promise.all([PRIMARY_VARIANT_ID, ...ids].map((id) => inspect(rawPath, id)));
}
export async function createWorkflowVariant(
  rawPath: string,
  workflow: SidecarWorkflow,
  sourceId = PRIMARY_VARIANT_ID,
): Promise<VariantSidecar> {
  if (workflow.variantId === PRIMARY_VARIANT_ID)
    throw new WorkflowVariantError(
      409,
      'Create a new variant identity; the primary already exists.',
    );
  const destination = await variantPath(rawPath, workflow.variantId);
  const source = await readWorkflowVariant(rawPath, sourceId);
  if (source === null)
    throw new WorkflowVariantError(409, 'Commit the source adjustments before creating a variant.');
  const output = await nativeValue('workflowEmbedXmp', [JSON.stringify(workflow), source]);
  const outcome = await writeSidecarCreateOnly(destination, output, 'Variant create failed');
  if (!outcome.ok)
    throw new WorkflowVariantError(
      'exists' in outcome ? 409 : 500,
      'exists' in outcome
        ? 'Variant identity already exists. Choose a new identity.'
        : outcome.error,
    );
  return inspect(rawPath, workflow.variantId);
}
export async function writeWorkflowVariant(
  rawPath: string,
  id: string,
  xml: string,
): Promise<string> {
  const destination = await variantPath(rawPath, id);
  return serializeSidecarWrite(destination, async () => {
    const existing = await readWorkflowVariant(rawPath, id);
    const oldRecord = existing === null ? null : await record(existing);
    const nextRecord = await record(xml);
    const output =
      nextRecord === null && oldRecord !== null
        ? await nativeValue('workflowEmbedXmp', [JSON.stringify(oldRecord), xml])
        : xml;
    requireIdentity(nextRecord ?? oldRecord, id, path.basename(destination));
    const outcome = await writeSidecarAtomic(destination, output, 'Variant write failed');
    if (!outcome.ok) throw new WorkflowVariantError(500, outcome.error);
    return output;
  });
}

/** Cooperating HTTP writers share a resolved-sidecar chain, including ordinary saves. */
export function commitWorkflowVariant(
  rawPath: string,
  id: string,
  expectedXmp: string | null,
  xmp: string,
  entry: WorkflowHistoryEntry,
): Promise<string> {
  return mutateVariant(rawPath, id, expectedXmp, async (current) => {
    const checkpoint = await nativeValue('workflowCheckpointXmp', [xmp]);
    const existing = current === null ? null : await record(current);
    const candidate =
      existing === null
        ? checkpoint
        : await nativeValue('workflowEmbedXmp', [JSON.stringify(existing), checkpoint]);
    return nativeValue('workflowCommitXmp', [candidate, JSON.stringify(entry)]);
  });
}
export function snapshotWorkflowVariant(
  rawPath: string,
  id: string,
  expectedXmp: string | null,
  snapshot: WorkflowSnapshot,
  initialXmp?: string,
): Promise<string> {
  return mutateVariant(rawPath, id, expectedXmp, async (current) => {
    const source = current ?? initialXmp;
    if (source === undefined)
      throw new WorkflowVariantError(
        409,
        'Commit the source adjustments before creating a snapshot.',
      );
    return nativeValue('workflowSnapshotXmp', [source, JSON.stringify(snapshot)]);
  });
}
export function restoreWorkflowVariant(
  rawPath: string,
  id: string,
  expectedXmp: string,
  entry: WorkflowHistoryEntry,
): Promise<string> {
  return mutateVariant(rawPath, id, expectedXmp, async (current) => {
    if (current === null)
      throw new WorkflowVariantError(404, 'The sidecar is missing. Restore it before editing.');
    return nativeValue('workflowRestoreXmp', [current, JSON.stringify(entry)]);
  });
}
async function mutateVariant(
  rawPath: string,
  id: string,
  expectedXmp: string | null,
  convert: (current: string | null) => Promise<string>,
): Promise<string> {
  const destination = await variantPath(rawPath, id);
  return serializeSidecarWrite(destination, async () => {
    const current = await readWorkflowVariant(rawPath, id);
    if (current !== expectedXmp)
      throw new WorkflowVariantError(409, 'Variant changed. Reopen it before saving this action.');
    const output = await convert(current);
    requireIdentity(await record(output), id, path.basename(destination));
    const result =
      current === null
        ? await writeSidecarCreateOnly(destination, output, 'Workflow action write failed')
        : await writeSidecarAtomic(destination, output, 'Workflow action write failed');
    if (!result.ok)
      throw new WorkflowVariantError(
        'exists' in result ? 409 : 500,
        'exists' in result ? 'Variant changed. Reopen it before saving this action.' : result.error,
      );
    return output;
  });
}
