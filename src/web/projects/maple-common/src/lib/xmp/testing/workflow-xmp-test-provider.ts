import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  initSync,
  workflow_checkpoint_xmp,
  workflow_commit_xmp,
  workflow_embed_xmp,
  workflow_read_xmp,
  workflow_restore_xmp,
  workflow_snapshot_xmp,
  workflow_variant_filename,
} from '../../raw-pipeline/pkg/raw_wasm';
import type {
  SidecarWorkflow,
  WorkflowHistoryEntry,
  WorkflowSnapshot,
} from '../../generated/workflow.generated';
import { WorkflowXmpService } from '../workflow-xmp.service';

let initialized = false;

function ensureWorkflowRuntime(): void {
  if (initialized) return;
  initSync({
    module: readFileSync(
      resolve(process.cwd(), 'projects/maple-common/src/lib/raw-pipeline/pkg/raw_wasm_bg.wasm'),
    ),
  });
  initialized = true;
}

function sidecar<T>(convert: (xml: string) => T): (xml: string) => Promise<T> {
  return async (xml) => {
    ensureWorkflowRuntime();
    return convert(xml);
  };
}

/** Exercise the actual Rust/WASM XMP contract when Node has no browser Worker. */
export const workflowXmpTestProvider = {
  provide: WorkflowXmpService,
  useValue: {
    read: sidecar((xml) => JSON.parse(workflow_read_xmp(xml))),
    variantFilename: async (name: string, id: string) => {
      ensureWorkflowRuntime();
      return workflow_variant_filename(name, id);
    },
    embed: async (workflow: SidecarWorkflow, xml: string) => {
      ensureWorkflowRuntime();
      return workflow_embed_xmp(JSON.stringify(workflow), xml);
    },
    checkpoint: sidecar(workflow_checkpoint_xmp),
    commit: async (entry: WorkflowHistoryEntry, xml: string) => {
      ensureWorkflowRuntime();
      return workflow_commit_xmp(xml, JSON.stringify(entry));
    },
    snapshot: async (snapshot: WorkflowSnapshot, xml: string) => {
      ensureWorkflowRuntime();
      return workflow_snapshot_xmp(xml, JSON.stringify(snapshot));
    },
    restore: async (entry: WorkflowHistoryEntry, xml: string) => {
      ensureWorkflowRuntime();
      return workflow_restore_xmp(xml, JSON.stringify(entry));
    },
  },
};
