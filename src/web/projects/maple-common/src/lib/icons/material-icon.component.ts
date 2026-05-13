// MaterialIcon — thin wrapper around Google Material Symbols Outlined.
// The webfont is loaded once via <link rel="stylesheet"> in index.html;
// this component only renders a span with the glyph name as text content.
//
// Glyph names map to https://fonts.google.com/icons?icon.set=Material+Symbols.
// Use this for system / chrome iconography (Settings, Account, etc.). The
// existing MapleIconComponent SVG sprite is reserved for editor-canvas
// iconography that needs to match the design-reference exactly.

import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

@Component({
  selector: 'maple-material-icon',
  standalone: true,
  imports: [],
  templateUrl: './material-icon.component.html',
  styleUrl: './material-icon.component.scss',
  // Belt-and-braces: a host-level rule alone doesn't survive emulated
  // ViewEncapsulation if the span ever gets reparented; the styles array
  // above scopes the rule to this component's template specifically.
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MaterialIconComponent {
  /** Material glyph name, e.g. `"settings"`, `"groups"`. */
  name = input.required<string>();
  /** Glyph font-size in px. */
  size = input<number>(16);
  /** CSS color for the glyph; falls back to `currentColor`. */
  color = input<string>('currentColor');

  /** Computed for tests / debugging. */
  protected readonly _resolvedSize = computed(() => `${this.size()}px`);
}
