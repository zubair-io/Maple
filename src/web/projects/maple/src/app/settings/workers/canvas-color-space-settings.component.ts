// CanvasColorSpaceSettingsComponent — the "Canvas colour space" panel on the
// Workers settings page (#3191, web half of the #1338 P3 toggle). A per-
// viewer DISPLAY preference (sRGB vs Display P3) for the GPU-live editor
// canvas, stored purely in this browser's `localStorage` via
// `CanvasColorSpacePref` — unlike its sibling `GpuLiveRenderSettingsComponent`
// above it, there is no server round-trip: which screen a browser is
// attached to is not something an operator-wide DB setting could express.
//
// Sits in the same "Rendering" group as the GPU live-render kill switch
// because both are client-side knobs for the web editor's render path, not
// server-side pipeline stages.

import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import {
  CanvasColorSpacePref,
  isCanvasColorSpace,
  MuiSegmentedToggleComponent,
  MuiSettingsRowComponent,
  type MuiSegmentedToggleOption,
} from '@maple-common';
import { SettingsIconComponent } from '../settings-icon.component';

const OPTIONS: readonly MuiSegmentedToggleOption[] = [
  { value: 'display-p3', label: 'Display P3' },
  { value: 'srgb', label: 'sRGB' },
];

@Component({
  selector: 'maple-canvas-color-space-settings',
  standalone: true,
  imports: [MuiSettingsRowComponent, MuiSegmentedToggleComponent, SettingsIconComponent],
  templateUrl: './canvas-color-space-settings.component.html',
  host: { class: 'set-vars set-workers-embedded-panel-host' },
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class CanvasColorSpaceSettingsComponent {
  // `protected`, not `private` — the template reads `pref.current()`
  // directly (jules review on #3224: a separate `value` signal duplicated
  // this state and could desync from the source of truth if the preference
  // ever changed from outside this component; reading through unifies on
  // one source instead of keeping a manually-synced copy).
  protected readonly pref = inject(CanvasColorSpacePref);

  protected readonly options = OPTIONS;
  protected readonly expanded = signal(false);

  protected toggleExpanded(): void {
    this.expanded.update((v) => !v);
  }

  protected onValueChange(next: string): void {
    // `mui-segmented-toggle`'s change event is a plain `string`, not
    // statically narrowed to `options`' values — guard before it reaches
    // the pref (localStorage) and the WASM session-open request.
    if (!isCanvasColorSpace(next)) return;
    this.pref.set(next);
  }

  /** One-line provenance readout for the collapsed header, mirroring
   * `GpuLiveRenderSettingsComponent.summaryLine`. */
  protected summaryLine(): string {
    return this.pref.isExplicit() ? 'Set by you' : 'Default (matches this screen)';
  }

  protected statusLabel(): string {
    return this.pref.current() === 'display-p3' ? 'P3' : 'sRGB';
  }

  protected statusColor(): string {
    return this.pref.current() === 'display-p3' ? 'var(--s-ok)' : 'var(--s-text-dim)';
  }
}
