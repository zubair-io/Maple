// Tailwind class-string constants/helpers for ImageCanvasComponent (port
// #3071) — extracted to stay under the per-file LOC budget.

/** Host element class. */
export const HOST_CLASS =
  'relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-[#080706]';

/** Mutually-exclusive color/border/background triplet for the toolbar's
 *  Before/After toggle button's active state — `.tool-btn.is-active` used to
 *  win over the base color/border/bg on the same element via a conditional
 *  class add-on; folded into one function instead. */
export function beforeAfterBtnClass(active: boolean): string {
  const base =
    'tool-btn flex h-6 w-6 cursor-pointer items-center justify-center rounded font-sans text-[11px] transition-colors duration-100';
  return active
    ? `${base} is-active bg-primary-dim text-primary border-[0.5px] border-primary`
    : `${base} text-text-muted bg-surface-alt border-[0.5px] border-border hover:bg-surface-hover hover:text-text-main`;
}
