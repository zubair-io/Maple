import { signal } from '@angular/core';
import { ActivatedRoute, convertToParamMap, provideRouter } from '@angular/router';
import { applicationConfig, type Meta, type StoryObj } from '@storybook/angular';
import {
  AuthService,
  BunApiBackendService,
  CloudBackupService,
  type ApiFolder,
  type BackupDestination,
  type GoogleBackupConfig,
} from '@maple-common';
import { NEVER, of, throwError } from 'rxjs';
import { BackupComponent } from './backup.component';

const library: ApiFolder = {
  id: 'library',
  label: 'Photography',
  path: '/Volumes/Photos',
  created_at: '2026-10-04',
  file_count: 1400,
  last_scan: null,
};
const google: BackupDestination = {
  id: 'google',
  libraryId: library.id,
  kind: 'google-drive',
  name: 'Google Drive',
  enabled: true,
  generation: 1,
  rootId: 'maple-photo-backup-root',
  path: null,
  accountId: 'account',
  status: {
    pending: 14,
    verified: 1380,
    trash: 6,
    purgePending: 0,
    blocked: 0,
    bytes: 84500000000,
    lastError: null,
  },
};
const folder: BackupDestination = {
  ...google,
  id: 'folder',
  kind: 'folder',
  name: 'Local archive',
  rootId: null,
  path: '/Volumes/Archive/Photos',
};
const config: GoogleBackupConfig = {
  clientMode: 'own',
  clientId: 'owner.apps.googleusercontent.com',
  clientSecretSet: true,
  callbackMode: 'relay',
  connected: true,
  accountId: 'account',
  accountEmail: 'photographer@example.com',
  rootId: google.rootId,
  callbackUrl: 'https://photos.example.com/api/cloud-backup/google/callback',
  googleRedirectUri: 'https://mapleeditor.com/api/connect/google-drive/callback',
  mapleClientAvailable: false,
};

const baseProviders = [
  provideRouter([]),
  {
    provide: ActivatedRoute,
    useValue: { snapshot: { queryParamMap: convertToParamMap({ connected: 'google' }) } },
  },
  { provide: AuthService, useValue: { user: signal({ role: 'owner' }) } },
  { provide: BunApiBackendService, useValue: { listFolders: () => of([library]) } },
];
const api = {
  destinations: () => of([google, folder]),
  googleConfig: () => of(config),
  catalog: () => of({ entries: [], purges: [] }),
  restoreJobs: () => of([]),
  retryDestination: () => of({ ok: true }),
  updateDestination: (_id: string, patch: Partial<BackupDestination>) =>
    of({ ...google, ...patch }),
  createDestination: (request: Partial<BackupDestination>) =>
    of({ ...google, ...request, id: 'new' }),
  removeDestination: () => of({ ok: true }),
};
const meta: Meta<BackupComponent> = {
  title: 'Pages/Self Hosted/Backup',
  component: BackupComponent,
  decorators: [
    applicationConfig({
      providers: [...baseProviders, { provide: CloudBackupService, useValue: api }],
    }),
  ],
  parameters: { layout: 'fullscreen' },
};
export default meta;
type Story = StoryObj<BackupComponent>;
export const Default: Story = {};
export const Loading: Story = {
  decorators: [
    applicationConfig({
      providers: [{ provide: CloudBackupService, useValue: { ...api, destinations: () => NEVER } }],
    }),
  ],
};
export const Empty: Story = {
  decorators: [
    applicationConfig({
      providers: [
        { provide: CloudBackupService, useValue: { ...api, destinations: () => of([]) } },
      ],
    }),
  ],
};
export const Error: Story = {
  decorators: [
    applicationConfig({
      providers: [
        {
          provide: CloudBackupService,
          useValue: {
            ...api,
            destinations: () =>
              throwError(() => new globalThis.Error('Cannot reach this Maple server.')),
          },
        },
      ],
    }),
  ],
};
export const EdgeCases: Story = {
  decorators: [
    applicationConfig({
      providers: [
        {
          provide: CloudBackupService,
          useValue: {
            ...api,
            destinations: () =>
              of([
                {
                  ...google,
                  enabled: false,
                  name: 'Wedding archive · offline destination',
                  status: {
                    ...google.status,
                    purgePending: 4,
                    blocked: 14,
                    lastError: 'Reconnect Google to complete permanent-delete obligations.',
                  },
                },
              ]),
            googleConfig: () =>
              of({
                ...config,
                connected: false,
                clientMode: 'maple',
                clientId: '',
                clientSecretSet: false,
                callbackUrl: null,
              }),
          },
        },
      ],
    }),
  ],
};

export const MapleClient: Story = {
  decorators: [
    applicationConfig({
      providers: [
        {
          provide: CloudBackupService,
          useValue: {
            ...api,
            googleConfig: () =>
              of({
                ...config,
                clientMode: 'maple',
                clientId: 'maple.apps.googleusercontent.com',
                clientSecretSet: false,
                connected: false,
                rootId: null,
                mapleClientAvailable: true,
              }),
          },
        },
      ],
    }),
  ],
};
export const OwnClientDirectCallback: Story = {
  decorators: [
    applicationConfig({
      providers: [
        {
          provide: CloudBackupService,
          useValue: {
            ...api,
            googleConfig: () =>
              of({ ...config, callbackMode: 'direct', googleRedirectUri: config.callbackUrl }),
          },
        },
      ],
    }),
  ],
};
