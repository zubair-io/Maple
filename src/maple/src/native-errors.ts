/** A backend/deployment failure that callers must retry, not skip per image. */
export class NativeBindingError extends Error {
  readonly code = 'MAPLE_NATIVE_BINDING' as const;

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'NativeBindingError';
  }
}

/** The code survives worker IPC and independent package copies. */
export function isNativeBindingError(error: unknown): error is NativeBindingError {
  return error instanceof Error && 'code' in error && error.code === 'MAPLE_NATIVE_BINDING';
}
