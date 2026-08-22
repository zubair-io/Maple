# Button

## Purpose
The primary interactive control for committing an action — the most-used atom in the system, and
the one the current per-platform audit found most inconsistently implemented (see the design
spec's audit section: Web's `<maple-button>` exists but is used nowhere outside its own Storybook
story; Apple and Windows have no reusable button at all).

## Variants
- **Primary** — filled `color.primary`, `color.text_main`-on-primary label. One per view region;
  the single visually loudest action.
- **Secondary** — `color.border` outline, `color.surface` fill, `color.text_main` label.
- **Ghost** — no fill, no border at rest; `color.surface_hover` fill on hover only. For toolbar/inline
  actions that shouldn't compete visually with primary content.
- **Destructive** — filled `color.error_text`-adjacent tone (implementations should introduce an
  `error` variant of the primary fill using `color.error_bg`/`color.error_text` — no dedicated
  "destructive fill" token exists yet in `ui_tokens.rs`; flag this as a follow-up token if a
  screen needs it before this gap is closed).

## States
- **Default** — as styled per variant above.
- **Hover** — background steps to `color.surface_hover` (secondary/ghost) or a darkened primary
  (primary/destructive); the unified guide specifies primary-hover as "darken + lift 2px" over
  ~200ms. **No token exists yet for this duration** (`MOTION_TOKENS` has no generic
  hover/press-interaction entry — its tokens are macro transitions like `drawer`/`push`/`sheet_*`).
  Implementations should hardcode 200ms consistently across all three platforms until a follow-up
  foundation task adds a tokenized `hover`/`press` motion pair; do not each guess a different
  number.
- **Pressed** — the hover lift returns to `translateY(0)` (per the unified guide); no color change
  on press.
- **Focused** — 1px `color.primary` border plus a 2px ring at `color.primary` 20% opacity, offset
  2px outward.
- **Disabled** — 40–50% opacity, `not-allowed` cursor (web) / disabled interaction (Apple/Windows).
  Never a separate greyed-out fill color — opacity is the only disabled signal.

## Tokens used
- Color: `color.primary`, `color.surface`, `color.surface_hover`, `color.border`, `color.text_main`,
  `color.text_muted` (label-on-disabled), `color.error_bg`/`color.error_text` (destructive, pending
  the follow-up noted above).
- Radius: `radius.md` (8px — the workhorse default for buttons, per `RADIUS_TOKENS`).
- Spacing: `spacing.sm` (8px, vertical inline padding) and `spacing.md` (16px, horizontal padding).
- Motion: 200ms hover-lift, 100ms color transition — not yet tokenized, see States above.

## Props
- `variant`: `primary | secondary | ghost | destructive` (default `secondary`).
- `label`: string — the visible and accessible text.
- `icon`: optional leading icon (see the Icon atom contract).
- `disabled`: boolean.
- `onPress` / `action`: the platform's native action callback (`() -> Void` in SwiftUI,
  `@Output() pressed` in Angular, `Click` event in WinUI).

## Accessibility
- Minimum 44×44pt (Apple) / 44×44px (Web, matching the guide's stated mobile touch-target minimum)
  hit target, even when the visible box is smaller (padding, not just visual size, must satisfy
  this).
- `label` is the accessible name; an icon-only button (no visible `label`) must still supply one via
  the platform's accessibility-label mechanism (SwiftUI `.accessibilityLabel`, Angular `aria-label`,
  WinUI `AutomationProperties.Name`) — never ship an icon-only button with no accessible name.
- Disabled buttons must be excluded from the tab/focus order, not merely visually dimmed.
