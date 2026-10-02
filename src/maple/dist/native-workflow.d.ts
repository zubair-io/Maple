export type WorkflowResult = {
    ok: true;
    value: string;
} | {
    ok: false;
    error: string;
};
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
type WorkflowLibrary = {
    symbols: Record<string, (...args: unknown[]) => unknown>;
};
/** Load only at the first workflow operation; older libraries still support existing operations. */
export declare function getWorkflowFfiSymbols(FFIType: Record<string, string | number>): {
    maple_workflow_commit_xmp: {
        args: (string | number)[];
        returns: string | number;
    };
    maple_workflow_snapshot_xmp: {
        args: (string | number)[];
        returns: string | number;
    };
    maple_workflow_restore_xmp: {
        args: (string | number)[];
        returns: string | number;
    };
    maple_workflow_validate_json: {
        args: (string | number)[];
        returns: string | number;
    };
    maple_workflow_read_xmp: {
        args: (string | number)[];
        returns: string | number;
    };
    maple_workflow_checkpoint_xmp: {
        args: (string | number)[];
        returns: string | number;
    };
    maple_workflow_variant_filename: {
        args: (string | number)[];
        returns: string | number;
    };
    maple_workflow_embed_xmp: {
        args: (string | number)[];
        returns: string | number;
    };
};
export declare function createWorkflowBinding(loadLibrary: (symbol: string) => WorkflowLibrary, ptr: (buf: Uint8Array) => unknown, getLastError: () => string | null): WorkflowBinding;
export {};
