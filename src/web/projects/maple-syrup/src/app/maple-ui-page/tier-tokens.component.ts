import { ChangeDetectionStrategy, Component } from '@angular/core';
import { MAPLE_UI_COLORS, MAPLE_UI_MOTION, MAPLE_UI_RADIUS, MAPLE_UI_SPACING } from '@maple-common';

// Tier 0 · Tokens tab of the Unified Component Catalog (#3000). Renders
// live from the generated single-source token tables — the page cannot
// drift from the system because it renders the system's own sources.
@Component({
  selector: 'app-tier-tokens',
  templateUrl: './tier-tokens.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class TierTokensComponent {
  readonly colorTokens = Object.entries(MAPLE_UI_COLORS).map(([key, value]) => ({ key, value }));
  readonly radiusTokens = Object.entries(MAPLE_UI_RADIUS).map(([key, value]) => ({
    key,
    px: value,
  }));
  readonly spacingTokens = Object.entries(MAPLE_UI_SPACING).map(([key, value]) => ({
    key,
    px: value,
  }));
  readonly motionTokens = Object.entries(MAPLE_UI_MOTION).map(([key, spec]) => ({
    key,
    ms: spec.ms,
    ease: spec.ease,
  }));
}
