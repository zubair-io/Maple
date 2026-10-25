import { Injectable, signal } from '@angular/core';
import type { AssetId } from '../models/asset';

/** Current Hosted folder's sidecars that cannot safely be overwritten. */
@Injectable({ providedIn: 'root' })
export class HostedSidecarErrors {
  readonly errors = signal(new Map<AssetId, string>());
}
