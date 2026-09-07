// retouch-panel.component.ts — Heal tool surface (#3409), the web twin of the
// Apple Heal panel.
//
// Takes the dock-side panel slot while the Heal tool is armed (the same swap
// the mask panel makes): the brush controls (Heal / Clone, size, feather,
// opacity) and the image's spot list with select / delete / reset all. The
// canvas half — discs and the source link — is `RetouchOverlayComponent`.
//
// Composed from the Maple UI primitives (`mui-segmented-toggle`,
// `mui-living-slider`, `mui-list-row`, `mui-button`, `mui-text`).
//
// The brush controls are session-level: they seed the next spot AND rewrite
// the selected one, so the panel reads as a brush rather than a per-spot
// form. Continuous edits ride `RetouchSessionService`'s gesture — one undo
// entry per drag — and discrete ones (mode change, delete, reset) commit
// their own, all as `repair`-class transactions.

import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { MuiButtonComponent } from '../../ui/button/mui-button.component';
import { MuiListRowComponent } from '../../ui/list-row/mui-list-row.component';
import { MuiLivingSliderComponent } from '../../ui/living-slider/mui-living-slider.component';
import {
  MuiSegmentedToggleComponent,
  type MuiSegmentedToggleOption,
} from '../../ui/segmented-toggle/mui-segmented-toggle.component';
import { MuiTextComponent } from '../../ui/text/mui-text.component';
import type { RetouchKind } from '../../models/retouch-spot';
import { RetouchSessionService } from '../retouch-overlay/retouch-session.service';

const KIND_OPTIONS: readonly MuiSegmentedToggleOption[] = [
  { value: 'heal', label: 'Heal' },
  { value: 'clone', label: 'Clone' },
];

/** Brush size in fractions of the image width — 0.2 % to 20 %, the range a
 *  dust spot through a whole distraction occupies. */
const RADIUS_MIN = 0.002;
const RADIUS_MAX = 0.2;

@Component({
  selector: 'editor-retouch-panel',
  standalone: true,
  imports: [
    MuiButtonComponent,
    MuiListRowComponent,
    MuiLivingSliderComponent,
    MuiSegmentedToggleComponent,
    MuiTextComponent,
  ],
  templateUrl: './retouch-panel.component.html',
  styleUrl: './retouch-panel.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class RetouchPanelComponent {
  protected readonly session = inject(RetouchSessionService);
  protected readonly kindOptions = KIND_OPTIONS;
  protected readonly radiusMin = RADIUS_MIN;
  protected readonly radiusMax = RADIUS_MAX;

  protected readonly rows = computed(() =>
    this.session.spots().map((spot, index) => ({
      index,
      title: `${spot.kind === 'clone' ? 'Clone' : 'Heal'} ${index + 1}`,
      subtitle: `${Math.round(spot.opacity * 100)}%`,
      active: this.session.selectedIndex() === index,
    })),
  );

  protected onKindChange(value: string): void {
    this.session.setKind(value === 'clone' ? 'clone' : ('heal' as RetouchKind));
  }

  protected onDragStart(): void {
    this.session.beginGesture();
  }

  protected onDragEnd(): void {
    this.session.endGesture();
  }
}
