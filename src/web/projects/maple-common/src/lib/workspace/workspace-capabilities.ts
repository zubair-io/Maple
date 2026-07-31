import { InjectionToken } from '@angular/core';

export type WorkspaceMode = 'hosted-single-file' | 'hosted-writable-folder' | 'self-hosted';

export interface WorkspaceCapabilities {
  readonly mode: WorkspaceMode;
  readonly xmpSave: 'download' | 'sibling';
  readonly mapleCacheWrite: boolean;
  readonly serverBacked: boolean;
}

export interface WorkspaceCapabilityPolicy {
  resolve(writableFolder: boolean): WorkspaceCapabilities;
}

const HOSTED_SINGLE_FILE: WorkspaceCapabilities = Object.freeze({
  mode: 'hosted-single-file',
  xmpSave: 'download',
  mapleCacheWrite: false,
  serverBacked: false,
});

const HOSTED_WRITABLE_FOLDER: WorkspaceCapabilities = Object.freeze({
  mode: 'hosted-writable-folder',
  xmpSave: 'sibling',
  mapleCacheWrite: true,
  serverBacked: false,
});

const SELF_HOSTED: WorkspaceCapabilities = Object.freeze({
  mode: 'self-hosted',
  xmpSave: 'sibling',
  mapleCacheWrite: true,
  serverBacked: true,
});

export const HOSTED_WORKSPACE_POLICY: WorkspaceCapabilityPolicy = Object.freeze({
  resolve: (writableFolder: boolean) =>
    writableFolder ? HOSTED_WRITABLE_FOLDER : HOSTED_SINGLE_FILE,
});

export const SELF_HOSTED_WORKSPACE_POLICY: WorkspaceCapabilityPolicy = Object.freeze({
  resolve: () => SELF_HOSTED,
});

export const WORKSPACE_CAPABILITIES = new InjectionToken<WorkspaceCapabilityPolicy>(
  'WORKSPACE_CAPABILITIES',
);
