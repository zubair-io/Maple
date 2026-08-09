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
import { AssetRenameService } from '../rename/asset-rename.service';
import { ASSET_RENAME_CAPABILITY } from '../rename/asset-rename-capability';
import { DragMoveService } from '../drag-move/drag-move.service';
import { DRAG_MOVE_CAPABILITY } from '../drag-move/drag-move-capability';
import { TrashService } from '../trash/trash.service';
import { TRASH_CAPABILITY } from '../trash/trash-capability';

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
    // #2637/#2706 — real inline-rename (POST /api/assets/:id/rename) only
    // wired up here, behind the AssetRenameCapability token the shared grid
    // /info-panel/browse-shell components inject. See
    // `asset-rename-capability.ts`'s module doc: this indirection is what
    // keeps `AssetRenameService` (and `BunApiBackendService` through it) out
    // of Hosted's static import graph.
    { provide: ASSET_RENAME_CAPABILITY, useExisting: AssetRenameService },
    // #2644 — drag-to-folder-tree move/copy, same indirection and same
    // reason: only the Self Hosted composition root's import graph should
    // ever reach `DragMoveService` (and `BunApiBackendService` through it).
    { provide: DRAG_MOVE_CAPABILITY, useExisting: DragMoveService },
    // #2652 — Trash pseudo-node (list/restore/delete-permanently), same
    // indirection and same reason: only the Self Hosted composition root's
    // import graph should ever reach `TrashService` (and `TrashApiService`
    // through it).
    { provide: TRASH_CAPABILITY, useExisting: TrashService },
  ]);
}
