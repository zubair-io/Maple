// MuiText — the Maple UI design-system Text atom
// (docs/design/maple-ui/components/text.md). Renders one step of the full
// type scale already tokenized in tokens.scss's Tailwind `@theme` block
// (--text-source-title, --text-sheet-title, --text-row-label, --text-body,
// --text-tool-label, --text-chip-label, --text-eyebrow, --text-value-chip,
// --text-filename — docs/design/responsive-program/s0-primitives.md §3.4),
// plus the four color roles and truncation/line-clamp behavior called for
// in the catalog row.

import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

export type MuiTextVariant =
  | 'source-title'
  | 'sheet-title'
  | 'row-label'
  | 'body'
  | 'tool-label'
  | 'chip-label'
  | 'eyebrow'
  | 'value-chip'
  | 'filename';

export type MuiTextColor = 'main' | 'muted' | 'on-accent' | 'success' | 'warning' | 'error';

@Component({
  selector: 'mui-text',
  standalone: true,
  templateUrl: './mui-text.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MuiTextComponent {
  readonly variant = input<MuiTextVariant>('body');
  readonly color = input<MuiTextColor>('main');
  /** Single-line ellipsis truncation. */
  readonly truncate = input<boolean>(false);
  /** Multi-line clamp — number of lines before an ellipsis, or `null` for
   * no clamping. Ignored when `truncate` is also set. */
  readonly lineClamp = input<number | null>(null);
  /** Renders as a block element instead of the default inline span — for a
   * "styled text block" used as its own paragraph/row rather than inline
   * within a sentence. */
  readonly block = input<boolean>(false);

  readonly isTruncating = computed(() => this.truncate());
  readonly isLineClamping = computed(() => !this.truncate() && this.lineClamp() !== null);

  /** Only four of the nine type-scale variants have a bundled `text-*`
   * utility in tokens.scss (the ones with a non-default font-family baked
   * in); the rest reuse the generated size/line-height/weight utility and
   * add `font-sans` alongside, since Tailwind v4's `--text-*` theme
   * namespace can't carry a `--font-family` modifier (see tokens.scss). */
  readonly variantClasses = computed(() => {
    switch (this.variant()) {
      case 'source-title':
        return 'text-source-title';
      case 'sheet-title':
        return 'text-sheet-title';
      case 'value-chip':
        return 'text-value-chip';
      case 'filename':
        return 'text-filename';
      case 'eyebrow':
        return 'text-eyebrow font-sans uppercase';
      default:
        return `text-${this.variant()} font-sans`;
    }
  });

  readonly colorClasses = computed(() => {
    switch (this.color()) {
      case 'muted':
        return 'text-text-muted';
      case 'success':
        return 'text-success-text';
      case 'warning':
        return 'text-warn';
      case 'error':
        return 'text-error-text';
      // 'on-accent': no dedicated token exists — text-main (near-white)
      // already reads correctly over the primary/error accent fills used
      // across the system (see button.md's primary-fill label color).
      default:
        return 'text-text-main';
    }
  });

  /** `block` wins over both truncate's `inline-block` and line-clamp's
   * `display: -webkit-box` when combined (matches the original
   * `.block.truncate, .block.line-clamp { display: block; }` override) —
   * folded into one computed rather than three competing display utilities
   * of equal specificity. */
  readonly displayClasses = computed(() => {
    if (this.block()) return 'block';
    if (this.isTruncating()) return 'inline-block max-w-full';
    if (this.isLineClamping()) return '[display:-webkit-box]';
    return 'inline';
  });

  readonly truncateClasses = computed(() =>
    this.isTruncating() ? 'overflow-hidden text-ellipsis whitespace-nowrap align-bottom' : '',
  );

  readonly lineClampClasses = computed(() =>
    this.isLineClamping() ? '[-webkit-box-orient:vertical] overflow-hidden' : '',
  );
}
