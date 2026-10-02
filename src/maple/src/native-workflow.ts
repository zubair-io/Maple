/** Pure workflow conversion at the confirmed-save boundary (#4036). */
import { WORKFLOW_MAX_BYTES } from './generated/workflow.generated';

export type WorkflowResult = { ok: true; value: string } | { ok: false; error: string };

export interface WorkflowBinding {
  workflowCommitXmp(xmp: string, entryJson: string): WorkflowResult;
  workflowSnapshotXmp(xmp: string, snapshotJson: string): WorkflowResult;
  workflowRestoreXmp(xmp: string, entryJson: string): WorkflowResult;
  workflowValidateJson(json: string): WorkflowResult;
  workflowReadXmp(xmp: string): WorkflowResult;
  workflowEmbedXmp(json: string, xmp: string): WorkflowResult;
  workflowCheckpointXmp(xmp: string): WorkflowResult;
  workflowVariantFilename(primaryName: string, variantId: string): WorkflowResult;
}

type WorkflowLibrary = { symbols: Record<string, (...args: unknown[]) => unknown> };

/** Load only at the first workflow operation; older libraries still support existing operations. */
export function getWorkflowFfiSymbols(FFIType: Record<string, string | number>) {
  return {
    maple_workflow_commit_xmp: {
      args: [
        FFIType.ptr,
        FFIType.u64,
        FFIType.ptr,
        FFIType.u64,
        FFIType.ptr,
        FFIType.u64,
        FFIType.ptr,
      ],
      returns: FFIType.i32,
    },
    maple_workflow_snapshot_xmp: {
      args: [
        FFIType.ptr,
        FFIType.u64,
        FFIType.ptr,
        FFIType.u64,
        FFIType.ptr,
        FFIType.u64,
        FFIType.ptr,
      ],
      returns: FFIType.i32,
    },
    maple_workflow_restore_xmp: {
      args: [
        FFIType.ptr,
        FFIType.u64,
        FFIType.ptr,
        FFIType.u64,
        FFIType.ptr,
        FFIType.u64,
        FFIType.ptr,
      ],
      returns: FFIType.i32,
    },
    maple_workflow_validate_json: {
      args: [FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.u64, FFIType.ptr],
      returns: FFIType.i32,
    },
    maple_workflow_read_xmp: {
      args: [FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.u64, FFIType.ptr],
      returns: FFIType.i32,
    },
    maple_workflow_checkpoint_xmp: {
      args: [FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.u64, FFIType.ptr],
      returns: FFIType.i32,
    },
    maple_workflow_variant_filename: {
      args: [
        FFIType.ptr,
        FFIType.u64,
        FFIType.ptr,
        FFIType.u64,
        FFIType.ptr,
        FFIType.u64,
        FFIType.ptr,
      ],
      returns: FFIType.i32,
    },
    maple_workflow_embed_xmp: {
      args: [
        FFIType.ptr,
        FFIType.u64,
        FFIType.ptr,
        FFIType.u64,
        FFIType.ptr,
        FFIType.u64,
        FFIType.ptr,
      ],
      returns: FFIType.i32,
    },
  };
}

export function createWorkflowBinding(
  loadLibrary: (symbol: string) => WorkflowLibrary,
  ptr: (buf: Uint8Array) => unknown,
  getLastError: () => string | null,
): WorkflowBinding {
  const libraries = new Map<string, WorkflowLibrary>();
  const convert = (symbol: string, inputs: readonly string[]): WorkflowResult => {
    let library = libraries.get(symbol);
    try {
      library ??= loadLibrary(symbol);
      libraries.set(symbol, library);
    } catch (error) {
      return {
        ok: false,
        error: `Workflow native bindings unavailable. Rebuild or update the native library: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    // Wire/XMP bounds come from Rust; output cannot exceed the sidecar bound.
    // Metadata conversion never runs inside a render loop.
    const out = Buffer.alloc(WORKFLOW_MAX_BYTES);
    const outLen = Buffer.alloc(8);
    if (inputs.some((value) => Buffer.byteLength(value, 'utf-8') > WORKFLOW_MAX_BYTES))
      return { ok: false, error: 'Workflow input exceeds byte budget' };
    const buffers = inputs.map((value) => Buffer.from(value, 'utf-8'));
    const empty = Buffer.alloc(1);
    const args = buffers.flatMap((buffer) => [
      ptr(buffer.length ? buffer : empty),
      BigInt(buffer.byteLength),
    ]);
    const rc = library.symbols[symbol](...args, ptr(out), BigInt(out.byteLength), ptr(outLen));
    if (rc !== 0)
      return { ok: false, error: getLastError() ?? `Workflow conversion failed: ${rc}` };
    const length = Number(outLen.readBigUInt64LE());
    if (length > out.byteLength) return { ok: false, error: 'Invalid workflow output length' };
    return { ok: true, value: out.subarray(0, length).toString('utf-8') };
  };
  return {
    workflowCommitXmp: (xmp, json) => convert('maple_workflow_commit_xmp', [xmp, json]),
    workflowSnapshotXmp: (xmp, json) => convert('maple_workflow_snapshot_xmp', [xmp, json]),
    workflowRestoreXmp: (xmp, json) => convert('maple_workflow_restore_xmp', [xmp, json]),
    workflowValidateJson: (json) => convert('maple_workflow_validate_json', [json]),
    workflowReadXmp: (xmp) => convert('maple_workflow_read_xmp', [xmp]),
    workflowEmbedXmp: (json, xmp) => convert('maple_workflow_embed_xmp', [json, xmp]),
    workflowCheckpointXmp: (xmp) => convert('maple_workflow_checkpoint_xmp', [xmp]),
    workflowVariantFilename: (primaryName, variantId) =>
      convert('maple_workflow_variant_filename', [primaryName, variantId]),
  };
}
