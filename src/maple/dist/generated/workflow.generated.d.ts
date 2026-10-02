export declare const WORKFLOW_VERSION = 1;
export declare const WORKFLOW_HISTORY_LIMIT = 32;
export declare const WORKFLOW_MAX_BYTES = 262144;
export declare const PRIMARY_VARIANT_ID = "primary";
export declare const WORKFLOW_MAX_TIMESTAMP_MS = 9007199254740991;
export declare const WORKFLOW_MARKUP_PATTERN = "<(?:[^<\\s:]+:)?Workflow(?=[\\s/>])";
export declare const WORKFLOW_UUID_PATTERN = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
export declare const WORKFLOW_ACTIONS: readonly ["adjustment", "preset", "paste", "reset", "snapshot-restore", "history-restore", "undo", "redo", "variant-create"];
export interface WorkflowSnapshot {
    readonly id: string;
    readonly name: string;
    readonly createdAtMs: number;
    readonly adjustmentXmp: string;
}
export interface WorkflowHistoryEntry {
    readonly id: string;
    readonly createdAtMs: number;
    readonly action: string;
    readonly label: string;
    readonly adjustmentXmp: string;
}
export interface SidecarWorkflow {
    readonly schemaVersion: number;
    readonly variantId: string;
    readonly variantName: string;
    readonly snapshots: readonly WorkflowSnapshot[];
    readonly history: readonly WorkflowHistoryEntry[];
}
/** Wire validation only. raw-core remains the checkpoint-XMP validator (#4035/#2437). */
export declare function parseSidecarWorkflow(input: unknown): SidecarWorkflow;
