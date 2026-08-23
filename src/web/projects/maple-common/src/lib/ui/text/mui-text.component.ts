// MuiText — the Maple UI design-system Text atom
// (docs/design/maple-ui/components/text.md). Renders one step of the full
// type scale already tokenized in tokens.scss's Tailwind `@theme` block
// (--text-source-title, --text-sheet-title, --text-row-label, --text-body,
// --text-tool-label, --text-chip-label, --text-eyebrow, --text-value-chip,
// --text-filename — docs/design/responsive-program/s0-primitives.md §3.4),
// plus the four color roles and truncation/line-clamp behavior called for
// in the catalog row.

import { ChangeDetectionStrategy, Component, input } from '@angular/core';

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
  styleUrl: './mui-text.component.scss',
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
}
