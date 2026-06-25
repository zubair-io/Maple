// ValueHudComponent — center-screen overlay during canvas scrub (#1535).
// Shows: eyebrow (group/tool name, muted) + large mono signed value
// (accent) + thin progress rail.
//
// The HUD is shown by the canvas scrub logic (controlled via the `visible`
// input from EditorShellComponent). It fades in at 120ms and fades out at
// 600ms after scrub ends.
//
// Phone: value 30px / rail 200px. Desktop: value 22px / rail 240px.

import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

@Component({
  selector: 'pro-value-hud',
  standalone: true,
  imports: [],
  templateUrl: './value-hud.component.html',
  styleUrl: './value-hud.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    class: 'pointer-events-none',
    '[class.hud--visible]': 'visible()',
  },
})
export class ValueHudComponent {
  /** Whether the HUD should be shown. */
  visible = input<boolean>(false);
  /** Eyebrow text — group and tool name (e.g. "Light · Exposure"). */
  eyebrow = input<string>('');
  /** Pre-formatted signed value string (e.g. "+2.30"). */
  valueText = input<string>('+0');
  /** Progress rail fill [0..1]. Maps the value within [-range, +range]. */
  progress = input<number>(0.5);
}
