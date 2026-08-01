export type FolderAccessFailure = 'permission-denied' | 'unreadable';

/** Recoverable user-facing failure while acquiring or opening a local folder. */
export class FolderAccessError extends Error {
  constructor(
    readonly failure: FolderAccessFailure,
    readonly inputName: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'FolderAccessError';
  }
}

export function folderPermissionError(inputName: string, cause?: unknown): FolderAccessError {
  return new FolderAccessError(
    'permission-denied',
    inputName,
    `Maple cannot open “${inputName}” because folder permission was denied or lost. Choose the folder again and allow read access.`,
    { cause },
  );
}

export function folderUnreadableError(inputName: string, cause?: unknown): FolderAccessError {
  return new FolderAccessError(
    'unreadable',
    inputName,
    `Maple could not read folder “${inputName}”. Check that it still exists, then choose it again.`,
    { cause },
  );
}
