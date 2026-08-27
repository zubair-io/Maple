// InfoFilenameRowComponent — S6 Info panel filename row (#2637).
//
// Renders the focused asset's filename, double-click to enter the shared
// inline-rename field — the same field the grid cell double-click and F2
// shortcut drive; only one is ever open at a time. Injects the
// `AssetRenameCapability` interface, NOT the concrete `AssetRenameService`
// (see `asset-rename-capability.ts`'s module doc) — this component is part
// of `<app-info-panel>`'s shared composition, reachable from both Hosted
// and Self Hosted, so importing the real service directly would pull
// `BunApiBackendService` into Hosted's bundle.

import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import type { Asset } from '../models/asset';
import { ASSET_RENAME_CAPABILITY } from '../rename/asset-rename-capability';
import { InlineRenameFieldComponent } from '../components/inline-rename-field/inline-rename-field.component';
import { MuiButtonComponent } from '../ui/button/mui-button.component';

@Component({
  selector: 'app-info-filename-row',
  standalone: true,
  imports: [InlineRenameFieldComponent, MuiButtonComponent],
  templateUrl: './info-filename-row.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    class: 'block',
    'data-testid': 'info-filename',
  },
})
export class InfoFilenameRowComponent {
  protected readonly renameSvc = inject(ASSET_RENAME_CAPABILITY);

  readonly asset = input<Asset | null>(null);

  protected readonly isEditing = computed(
    () => this.asset() !== null && this.renameSvc.editingAssetId() === this.asset()?.id,
  );

  protected readonly disabledReason = computed(() => {
    const a = this.asset();
    return a ? this.renameSvc.disabledReason(a) : 'No asset selected';
  });

  protected readonly isCollision = computed(() => {
    const a = this.asset();
    return a !== null && this.renameSvc.collision()?.assetId === a.id;
  });

  onDblClick(): void {
    const a = this.asset();
    if (a) this.renameSvc.startEditing(a);
  }

  onCommit(newFilename: string): void {
    const a = this.asset();
    if (a) this.renameSvc.commit(a, newFilename);
  }

  onCollisionResolved(policy: 'replace' | 'keep-both'): void {
    const a = this.asset();
    if (a) this.renameSvc.resolveCollision(a, policy);
  }
}
