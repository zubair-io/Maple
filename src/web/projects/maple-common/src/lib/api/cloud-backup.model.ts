export interface BackupDestinationStatus {
  pending: number;
  verified: number;
  trash: number;
  purgePending: number;
  blocked: number;
  bytes: number;
  lastError: string | null;
  missing?: number;
  prepared?: number;
}

export interface BackupDestination {
  id: string;
  libraryId: string;
  kind: 'folder' | 'google-drive';
  name: string;
  enabled: boolean;
  generation: number;
  path: string | null;
  rootId: string | null;
  accountId: string | null;
  status: BackupDestinationStatus;
}

export interface GoogleBackupConfig {
  clientId: string;
  clientSecretSet: boolean;
  callbackMode: 'direct' | 'relay';
  connected: boolean;
  accountId: string | null;
  accountEmail: string | null;
  rootId: string | null;
  callbackUrl: string | null;
  googleRedirectUri: string | null;
  mapleClientAvailable: false;
}

export interface GoogleBackupConfigPatch {
  clientId: string;
  clientSecret?: string | null;
  callbackMode: 'direct' | 'relay';
  rootId?: string;
}

export interface BackupManifestDto {
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
    object: { key: string; locator: string; size: number; sha256: string };
  }>;
}

export interface BackupCatalog {
  entries: BackupManifestDto[];
  purges: Array<{
    version: 1;
    libraryId: string;
    entryId: string;
    sequence: number;
    purgedAt: string;
  }>;
}

export interface BackupRestoreRequest {
  targetPath: string;
  includeTrash: boolean;
  entryId?: string;
  sequence?: number;
}

export interface BackupRestorePreview {
  files: number;
  bytes: number;
  entries: number;
  gaps: string[];
}

export interface BackupRestoreJob {
  id: string;
  status: 'queued' | 'running' | 'done' | 'failed' | 'cancelled';
  progress: { current: number; total: number };
  error: string | null;
  result: Record<string, unknown> | null;
  cancel_requested: boolean;
  created_at?: string;
}
