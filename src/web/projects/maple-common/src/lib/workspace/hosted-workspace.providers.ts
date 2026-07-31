import { EnvironmentProviders, makeEnvironmentProviders } from '@angular/core';
import { FsAccessLibrarySource } from '../addressing/fs-access-library-source';
import { LIBRARY_SOURCE } from '../addressing/library-source';
import { LIBRARY_BACKEND } from '../api/library-backend.token';
import { HOSTED_WORKSPACE_POLICY, WORKSPACE_CAPABILITIES } from './workspace-capabilities';
import { SERVER_WORKSPACE_PERSISTENCE } from './workspace-persistence';
import { SERVER_LIBRARY_IO } from './server-library-io';

export function provideHostedWorkspace(): EnvironmentProviders {
  return makeEnvironmentProviders([
    { provide: LIBRARY_BACKEND, useValue: 'hosted' },
    { provide: LIBRARY_SOURCE, useExisting: FsAccessLibrarySource },
    { provide: WORKSPACE_CAPABILITIES, useValue: HOSTED_WORKSPACE_POLICY },
    { provide: SERVER_WORKSPACE_PERSISTENCE, useValue: null },
    { provide: SERVER_LIBRARY_IO, useValue: null },
  ]);
}
