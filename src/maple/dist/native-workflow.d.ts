export type WorkflowResult = {
    ok: true;
    value: string;
} | {
    ok: false;
    error: string;
};
export interface WorkflowBinding {
    workflowValidateJson(json: string): WorkflowResult;
    workflowReadXmp(xmp: string): WorkflowResult;
    workflowEmbedXmp(json: string, xmp: string): WorkflowResult;
}
export declare function createWorkflowBinding(lib: {
    symbols: Record<string, (...args: unknown[]) => unknown>;
}, ptr: (buf: Uint8Array) => unknown, getLastError: () => string | null): WorkflowBinding;
