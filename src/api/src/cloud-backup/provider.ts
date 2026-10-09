/** Portable object contract for #4223. Google locators stay inside its adapter. */
export interface BackupObject {
  key: string;
  locator: string;
  size: number;
  sha256: string;
}

export interface UploadCheckpoint {
  provider: string;
  version: 1;
  state: Record<string, unknown>;
}

export interface PublishSource {
  size: number;
  sha256: string;
  /** Display metadata does not participate in the immutable logical key. */
  name?: string;
  contentType?: string;
  /** A fresh stream for each retry, starting at the requested byte offset. */
  open: (offset: number) => ReadableStream<Uint8Array>;
}

export interface BackupProvider {
  probe(signal?: AbortSignal): Promise<void>;
  list(prefix: string, signal?: AbortSignal): AsyncIterable<BackupObject>;
  inspect(key: string, signal?: AbortSignal, locator?: string): Promise<BackupObject | null>;
  publish(
    key: string,
    source: PublishSource,
    options: {
      signal?: AbortSignal;
      checkpoint?: UploadCheckpoint | null;
      saveCheckpoint: (checkpoint: UploadCheckpoint) => Promise<void>;
    },
  ): Promise<BackupObject>;
  /** Keep a user-visible file at its library-relative path, replacing its current bytes. */
  mirrorFile(
    key: string,
    relativePath: string,
    source: PublishSource,
    options: {
      signal?: AbortSignal;
      checkpoint?: UploadCheckpoint | null;
      saveCheckpoint: (checkpoint: UploadCheckpoint) => Promise<void>;
    },
  ): Promise<BackupObject>;
  download(object: BackupObject, signal?: AbortSignal): Promise<ReadableStream<Uint8Array>>;
  remove(object: BackupObject, signal?: AbortSignal): Promise<void>;
  /** Cancels an upload and reports it if a replacement completed before its checkpoint was saved. */
  abort(checkpoint: UploadCheckpoint, signal?: AbortSignal): Promise<BackupObject | null>;
}

export interface BackupManifest {
  version: 1;
  libraryId: string;
  entryId: string;
  assetId: string;
  sequence: number;
  state: 'active' | 'trash';
  originalPath: string;
  currentPath: string;
  deletedAt: string | null;
  hidden: boolean;
  files: Array<{
    path: string;
    role: 'original' | 'sidecar' | 'companion';
    object: BackupObject;
  }>;
}

export interface PurgeRecord {
  version: 1;
  libraryId: string;
  entryId: string;
  sequence: number;
  purgedAt: string;
}
