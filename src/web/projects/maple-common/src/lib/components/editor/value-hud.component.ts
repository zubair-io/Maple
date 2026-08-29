// ValueHudComponent — center-screen overlay during canvas scrub (#1535).
// Shows: eyebrow (group/tool name, muted) + large mono signed value
// (accent) + thin progress rail.
//
// The HUD is shown by the canvas scrub logic (controlled via the `visible`
// input from EditorShellComponent). It fades in at 120ms and fades out at
// 600ms after scrub ends.
//
// Phone: value 30px / rail 200px. Desktop: value 22px / rail 240px.

import { ChangeDetectionStrategy, Component, input } from '@angular/core';

@Component({
  selector: 'pro-value-hud',
  standalone: true,
  imports: [],
  templateUrl: './value-hud.component.html',
  styleUrl: './value-hud.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    class: 'pointer-events-none flex items-center justify-center',
    '[class]': 'hostVisibilityClass()',
  },
})
export class ValueHudComponent {
  /** Whether the HUD should be shown. */
  visible = input<boolean>(false);

  /** Mutually-exclusive opacity/transition pair (Tailwind port #3071) —
   * `.hud--visible` used to override the base `:host`'s `opacity: 0` and
   * fade-out transition token with a different fade-in token; folded into
   * one computed host-class string per the port's host-class rule. */
  protected hostVisibilityClass(): string {
    return this.visible()
      ? 'hud--visible opacity-100 transition-opacity [transition-duration:var(--pro-motion-hud-in)]'
      : 'opacity-0 transition-opacity [transition-duration:var(--pro-motion-hud-out)]';
  }
  /** Eyebrow text — group and tool name (e.g. "Light · Exposure"). */
  eyebrow = input<string>('');
  /** Pre-formatted signed value string (e.g. "+2.30"). */
  valueText = input<string>('+0');
  /** Progress rail fill [0..1]. Maps the value within [-range, +range]. */
  progress = input<number>(0.5);
}
