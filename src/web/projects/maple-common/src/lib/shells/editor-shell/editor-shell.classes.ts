// Tailwind class-string constants/helpers for EditorShellComponent (port
// #3071) — extracted to stay under the per-file LOC budget, same precedent
// as editor-shell-chrome.ts / editor-shell-scrub.ts / editor-shell-undo.ts.
// Pure functions only: each takes the small bit of component state it needs
// and returns the class string, so the component's `computed`/method bodies
// stay one-line delegations.

/** Chrome visibility states driven by idle timer + scrub. */
export type ChromeState = 'full' | 'receded' | 'scrubbing';

/** Host element class (Tailwind port #3071). */
export const HOST_CLASS =
  'pro-editor-shell block w-screen h-dvh box-border overflow-hidden bg-[color:var(--pro-canvas)]';

/** Mutually-exclusive de-emphasise/disable pair for the gray-mixer sliders
 *  while Black & White is Off — folded into one string rather than a base
 *  class plus a conditional `opacity`/`pointer-events` add-on.
 *  `bw-panel-sliders--inactive` kept bare — asserted via `classList.contains`
 *  in editor-shell-black-white.spec.ts. */
export function bwPanelSlidersClass(blackWhiteOn: boolean): string {
  return blackWhiteOn ? '' : 'bw-panel-sliders--inactive opacity-40 pointer-events-none';
}

/** Mutually-exclusive opacity triplet for the chrome layer's
 *  recede/scrub states — `full`/`receded`/`scrubbing` all set `opacity`,
 *  so this is one function rather than a base class plus conditional
 *  add-ons. */
export function chromeLayerOpacityClass(state: ChromeState): string {
  switch (state) {
    case 'receded':
      return 'opacity-30';
    case 'scrubbing':
      return 'opacity-[0.15]';
    default:
      return 'opacity-100';
  }
}

/** Mutually-exclusive color/border/opacity triplet for the top bar's icon
 *  toggle buttons (before/after split, info) — the `--active` state used to
 *  win over `:hover` on the shared `background`/`border-color` properties
 *  via declaration order; folded into one string rather than a base class
 *  plus a conditional add-on. */
export function iconBtnClass(active: boolean): string {
  return active
    ? 'bg-[color:var(--pro-accent-28)] border-[0.5px] border-[color:var(--pro-accent)]'
    : 'border-[0.5px] border-transparent bg-transparent hover:border-[color:var(--pro-border)] hover:bg-white/8';
}

/** Mutually-exclusive color/border/opacity triplet for the top bar's Export
 *  icon button — same rationale as {@link iconBtnClass}. */
export function exportBtnClass(enabled: boolean): string {
  return enabled
    ? 'bg-[color:var(--pro-accent-28)] text-[color:var(--pro-accent)] border-[0.5px] border-[color:var(--pro-accent)]'
    : 'bg-white/4 text-[color:var(--pro-text-dim)] border-[0.5px] border-[color:var(--pro-border)] opacity-50 cursor-default';
}

/** Mutually-exclusive color/border/opacity triplet for the AUTO button's
 *  busy/disabled/default states — `.top-text-btn--busy` used to win over
 *  both `:hover` and `:disabled` on `color`/`border-color`/`opacity` via
 *  declaration order (it was the last matching rule); folded into one
 *  string with the same busy-first precedence rather than a base class plus
 *  conditional add-ons. */
export function autoButtonClass(autoInFlight: boolean, autoDisabled: boolean): string {
  if (autoInFlight) {
    return 'text-[color:var(--pro-accent)] border-[color:var(--pro-accent)] bg-white/5 opacity-100 cursor-pointer';
  }
  if (autoDisabled) {
    return 'text-[color:var(--pro-text-muted)] border-[color:var(--pro-border)] bg-white/5 opacity-40 cursor-default';
  }
  return 'text-[color:var(--pro-text-muted)] border-[color:var(--pro-border)] bg-white/5 opacity-100 cursor-pointer enabled:hover:bg-white/10 enabled:hover:text-[color:var(--pro-text)]';
}
