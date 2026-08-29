// MuiIcon — the Maple UI design-system Icon atom. Wraps the existing
// MapleIconComponent (stroke-SVG registry) rather than inventing a second
// glyph set; adds the five-step size scale from
// docs/design/maple-ui/components/icon.md (xs 14 / sm 16 / md 24 / lg 30 /
// xl 36) which MapleIconComponent itself only exposes as a raw pixel input.

import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { MapleIconComponent } from '../../icons/maple-icon.component';
import type { MapleIconName } from '../../icons/maple-icon.component';

export type { MapleIconName } from '../../icons/maple-icon.component';

export type MuiIconSize = 'xs' | 'sm' | 'md' | 'lg' | 'xl';

const ICON_SIZE_PX: Record<MuiIconSize, number> = {
  xs: 14,
  sm: 16,
  md: 24,
  lg: 30,
  xl: 36,
};

@Component({
  selector: 'mui-icon',
  standalone: true,
  imports: [MapleIconComponent],
  templateUrl: './mui-icon.component.html',
  // aria-hidden lives on this component's own host element (not on the
  // wrapped <maple-icon>) so a caller inspecting the <mui-icon> tag — or
  // assistive tech walking the DOM — sees it at the boundary of the atom.
  host: {
    class: 'inline-flex leading-[0]',
    '[attr.aria-hidden]': "decorative() ? 'true' : null",
  },
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MuiIconComponent {
  readonly name = input.required<MapleIconName>();
  readonly size = input<MuiIconSize>('md');
  readonly color = input<string>('currentColor');
  /** True (default) hides the glyph from assistive tech — the normal case
   * where an icon sits beside a visible label (button icon, badge glyph).
   * Set to `false` only when this Icon is used standalone as meaningful
   * content and the wrapping context supplies no other accessible name. */
  readonly decorative = input<boolean>(true);

  readonly pixelSize = computed(() => ICON_SIZE_PX[this.size()]);
}
