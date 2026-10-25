import { Injectable } from '@angular/core';
import type { AssetId } from '../../models/asset';

/** One-shot grid position retained while a photo's Preview route is open. */
export interface BrowseReturnPosition {
  readonly sourceId: string;
  readonly assetId: AssetId;
  readonly scrollTop: number;
}

@Injectable({ providedIn: 'root' })
export class BrowseReturnPositionService {
  private pending: BrowseReturnPosition | null = null;

  remember(position: BrowseReturnPosition): void {
    this.pending = position;
  }

  forSource(sourceId: string | null | undefined): BrowseReturnPosition | null {
    return this.pending?.sourceId === sourceId ? this.pending : null;
  }

  clear(): void {
    this.pending = null;
  }
}
