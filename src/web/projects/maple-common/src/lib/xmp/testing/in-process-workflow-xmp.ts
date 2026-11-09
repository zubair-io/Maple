import {
  workflow_checkpoint_xmp,
  workflow_commit_xmp,
  workflow_cursor_xmp,
  workflow_embed_xmp,
  workflow_read_xmp,
  workflow_reconcile_xmp,
  workflow_restore_xmp,
  workflow_snapshot_xmp,
  workflow_variant_filename,
} from '../../raw-pipeline/pkg/raw_wasm';
import {
  parseSidecarWorkflow,
  type SidecarWorkflow,
  type WorkflowHistoryEntry,
  type WorkflowSnapshot,
} from '../../generated/workflow.generated';
import type { WorkflowCursor } from '../workflow-xmp.service';

/** The real Rust workflow converter, in-process because jsdom has no Worker. */
export const inProcessWorkflowXmp = {
  async read(xmp: string): Promise<SidecarWorkflow | null> {
    const value: unknown = JSON.parse(workflow_read_xmp(xmp));
    return value === null ? null : parseSidecarWorkflow(value);
  },
  async variantFilename(primaryName: string, variantId: string): Promise<string> {
    return workflow_variant_filename(primaryName, variantId);
  },
  async checkpoint(xmp: string): Promise<string> {
    return workflow_checkpoint_xmp(xmp);
  },
  async embed(workflow: SidecarWorkflow, xmp: string): Promise<string> {
    return workflow_embed_xmp(JSON.stringify(parseSidecarWorkflow(workflow)), xmp);
  },
  async snapshot(snapshot: WorkflowSnapshot, xmp: string): Promise<string> {
    return workflow_snapshot_xmp(xmp, JSON.stringify(snapshot));
  },
  async commit(entry: WorkflowHistoryEntry, xmp: string): Promise<string> {
    return workflow_commit_xmp(xmp, JSON.stringify(entry));
  },
  async restore(entry: WorkflowHistoryEntry, xmp: string): Promise<string> {
    return workflow_restore_xmp(xmp, JSON.stringify(entry));
  },
  async reconcile(base: string, current: string, incoming: string, nowMs: number): Promise<string> {
    return workflow_reconcile_xmp(base, current, incoming, nowMs);
  },
  async cursor(xmp: string): Promise<WorkflowCursor> {
    return JSON.parse(workflow_cursor_xmp(xmp)) as WorkflowCursor;
  },
};
