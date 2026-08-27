# Toast

**Tier:** Atom

## Purpose

A transient, non-blocking notification for something that just happened outside the user's direct
focus — an export finished, a batch operation failed, an undo-able action completed — surfaced
briefly rather than requiring acknowledgment like a dialog would.

## Variants

- **Info** — neutral notice.
- **Success** — an action completed as expected.
- **Warning** — completed, but with something the user should know about.
- **Error** — the action failed.

Each variant pairs a semantic icon with the corresponding token color; layout is otherwise
identical across all four.

## States

- **Entering** — the toast mounts hidden (opacity 0, offset down 8px) and transitions to its
  resting position on the next tick, using the `sheet-present` motion pair (320ms) — the closest
  existing duration to a toast's own slide-and-fade-in.
- **Resting** — fully visible; auto-dismiss timer (if any) is running.
- **Leaving** — dismiss (auto-timeout or manual close) starts the exit transition using the
  `sheet-dismiss` motion pair (280ms); the `dismissed` output fires only once that transition
  finishes, so a caller removing the toast from a list never cuts the animation short.

## Tokens used

- Color: `color.surface_alt` (background), `color.border` (outline), `color.text_main` (message),
  `color.primary` (action button), `color.text_muted` / `color.success_text` / `color.warn` /
  `color.error_text` (per-variant icon).
- Radius: `radius.md` — same tier as Button/Input/cards, per the radius table's "workhorse
  default."
- Motion: `sheet-present` (enter) / `sheet-dismiss` (exit) — see States above.

## Props

- `variant`: `info | success | warning | error` (default `info`).
- `message`: string (required).
- `actionLabel`: optional string — renders an inline text action button when present.
- `autoDismissMs`: number or `null` (default `5000`) — `null` disables auto-dismiss entirely.
- `actionPressed`: output, fired when the action button is clicked.
- `dismissed`: output, fired once the toast has fully left (after the exit motion completes) —
  the caller's cue to actually remove it from whatever list is rendering active toasts.
- `dismissible`: boolean (default `true`) — `false` hides the close button, for a toast whose
  dismissal must stay in the caller's hands (e.g. a persistent capability warning the user
  shouldn't be able to lose track of). Added toast sweep, ticket #3043.
- `ariaLabel`: string or `null` (default `null`) — overrides the host's accessible name, for a
  caller with more than one concurrent toast whose meaning isn't obvious from `role="status"`
  alone. Added toast sweep, ticket #3043.
- `surface`: `default | glass` (default `default`) — `glass` swaps the flat app-chrome surface for
  the editor canvas's glass material (`--pro-glass-*`, pro-tokens.scss, #1535), for a toast that
  has to stay legible floating over live photo pixels rather than page chrome. Added toast sweep,
  ticket #3043.

## Accessibility

- Host renders `role="status"` with `aria-live="polite"` so a toast's arrival is announced without
  stealing focus — appropriate for a non-blocking notice, unlike a dialog which would need
  `role="alert"`/focus trapping.
- The close button is a real labeled `<button aria-label="Dismiss">`, not an icon-only tap target
  with no accessible name. Omitted entirely when `dismissible` is `false`.
- Auto-dismiss never removes a toast that still needs an explicit user response — a toast carrying
  an action button is still subject to `autoDismissMs` by default (the same pattern as most native
  toast systems), but callers with an action the user must consciously choose should pass
  `autoDismissMs: null`.
