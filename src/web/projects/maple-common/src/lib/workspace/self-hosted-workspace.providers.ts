import { EnvironmentProviders, inject, makeEnvironmentProviders } from '@angular/core';
import { map } from 'rxjs';
import { HttpLibrarySource } from '../addressing/http-library-source';
import { LIBRARY_SOURCE } from '../addressing/library-source';
import { BunApiBackendService } from '../api/bun-api-backend.service';
import { LIBRARY_BACKEND } from '../api/library-backend.token';
import { SELF_HOSTED_WORKSPACE_POLICY, WORKSPACE_CAPABILITIES } from './workspace-capabilities';
import {
  SERVER_WORKSPACE_PERSISTENCE,
  type ServerWorkspacePersistence,
} from './workspace-persistence';
import { SERVER_LIBRARY_IO } from './server-library-io';

function serverPersistenceFactory(): ServerWorkspacePersistence {
  const api = inject(BunApiBackendService);
  return {
    readSidecar: (path) => api.getXmp(path),
    writeSidecar: (path, xml) => api.putXmp(path, xml).pipe(map(() => undefined)),
    writePreview: (path, bytes, contentType) =>
      api.putPreview(path, bytes, contentType).pipe(map(() => undefined)),
  };
}

export function provideSelfHostedWorkspace(): EnvironmentProviders {
  return makeEnvironmentProviders([
    { provide: LIBRARY_BACKEND, useValue: 'self-hosted' },
    { provide: LIBRARY_SOURCE, useExisting: HttpLibrarySource },
    { provide: WORKSPACE_CAPABILITIES, useValue: SELF_HOSTED_WORKSPACE_POLICY },
    { provide: SERVER_WORKSPACE_PERSISTENCE, useFactory: serverPersistenceFactory },
    { provide: SERVER_LIBRARY_IO, useExisting: BunApiBackendService },
  ]);
}
