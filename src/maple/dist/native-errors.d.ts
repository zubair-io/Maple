/** A backend/deployment failure that callers must retry, not skip per image. */
export declare class NativeBindingError extends Error {
    readonly code: "MAPLE_NATIVE_BINDING";
    constructor(message: string, options?: ErrorOptions);
}
/** The code survives worker IPC and independent package copies. */
export declare function isNativeBindingError(error: unknown): error is NativeBindingError;
