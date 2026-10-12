// InfoMirrorsComponent — pure view-model module (`*.vm.ts`, #190).
//
// Projects the per-destination backup state the API returns on asset
// metadata (`ApiAssetDetail.mirrors`, #4500) into the rows the Backups
// section renders. No `@angular/*` imports.

import type { ApiAssetMirrorState } from '../api/bun-api-backend.service';
import type { MuiStatusTextState } from '../ui/status-text/mui-status-text.component';

export interface MirrorStatusVm {
  readonly state: MuiStatusTextState;
  readonly text: string;
}

export interface MirrorRowVm {
  readonly destinationId: string;
  readonly name: string;
  readonly path: string;
  readonly statuses: readonly MirrorStatusVm[];
  readonly lastError: string | null;
}

const PAUSED: MirrorStatusVm = { state: 'offline', text: 'Paused' };
const FAILED: MirrorStatusVm = { state: 'error', text: 'Sync failed' };

function lifecycleStatus(mirror: ApiAssetMirrorState): MirrorStatusVm {
  switch (mirror.status) {
    case 'purged':
      return { state: 'idle', text: 'Purged' };
    case 'trash':
      return { state: 'idle', text: 'In Trash' };
    case 'synced':
      return { state: 'saved', text: 'Synced' };
    case 'pending':
      return { state: 'saving', text: 'Pending' };
    case 'paused':
      return PAUSED;
    case 'error':
      return FAILED;
  }
}

/** A destination can be paused and carry a recorded failure at the same
 * time; the server's single `status` ranks error above paused, so the row
 * shows both facts side by side instead of letting one hide the other. */
function statuses(mirror: ApiAssetMirrorState): MirrorStatusVm[] {
  const lifecycle = lifecycleStatus(mirror);
  const paused = !mirror.enabled && mirror.status === 'error' ? [PAUSED] : [];
  const failed = mirror.lastError && mirror.status !== 'error' ? [FAILED] : [];
  return [...paused, lifecycle, ...failed];
}

export function mirrorRows(mirrors: readonly ApiAssetMirrorState[]): MirrorRowVm[] {
  return mirrors.map((mirror) => ({
    destinationId: mirror.destinationId,
    name: mirror.destinationName,
    path: mirror.path,
    statuses: statuses(mirror),
    lastError: mirror.lastError,
  }));
}
