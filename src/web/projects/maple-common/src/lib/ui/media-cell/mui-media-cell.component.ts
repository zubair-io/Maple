// MuiMediaCell — Maple UI Molecules-L2 (unified-component-catalog.md §3).
// Thumbnail with badges, rating, selection — built from Image, Badge,
// Rating & Flags, Inline Rename Field. The core grid-cell primitive that
// Filmstrip Row/Rail compose.

import { ChangeDetectionStrategy, Component, input, model, output } from '@angular/core';
import { MuiBadgeComponent } from '../badge/mui-badge.component';
import { MuiImageComponent } from '../image/mui-image.component';
import { MuiInlineRenameFieldComponent } from '../inline-rename-field/mui-inline-rename-field.component';
import { MuiRatingFlagsComponent } from '../rating-flags/mui-rating-flags.component';
import type { MuiRatingFlagState } from '../rating-flags/mui-rating-flags.component';
import { handleActivationKeydown } from '../internal/activation-keydown';

export type MuiMediaCellSize = 'sm' | 'md' | 'fill';

/** `stacked` (default) is the original card layout: image on top, badges
 * in a corner row, filename + rating/flags in a `.meta` row below.
 * `overlay` renders badges and rating/flags ON TOP of the image itself
 * (Lightroom-style grid-cell chrome) instead of a `.meta` row, and drops
 * the built-in rename field entirely — see the `mediaCellTopLeft` /
 * `mediaCellTopRight` / `mediaCellFooter` projection slots below for how a
 * caller supplies its own overlay content and rename UI. */
export type MuiMediaCellLayout = 'stacked' | 'overlay';

@Component({
  selector: 'mui-media-cell',
  standalone: true,
  imports: [
    MuiBadgeComponent,
    MuiImageComponent,
    MuiInlineRenameFieldComponent,
    MuiRatingFlagsComponent,
  ],
  templateUrl: './mui-media-cell.component.html',
  styleUrl: './mui-media-cell.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    // Host-level sizing/positioning classes rather than template classes on
    // an inner wrapper: `overlay` layout needs the *custom-element host
    // itself* to establish the `position: relative` box that its
    // absolutely-positioned overlay chrome — and a caller's projected
    // `mediaCellFooter` content, rendered as a DOM sibling of the
    // interactive cell rather than nested inside it (see the footer slot
    // doc below) — position against.
    '[class.size-fill]': "size() === 'fill'",
    '[class.layout-overlay]': "layout() === 'overlay'",
  },
})
export class MuiMediaCellComponent {
  readonly src = input.required<string>();
  readonly alt = input.required<string>();
  readonly filename = model<string>('');
  /** Short text badges (e.g. media type, RAW) rendered top of the thumbnail.
   * `stacked` layout only — `overlay` layout renders its corner chrome
   * from the `mediaCellTopLeft`/`mediaCellTopRight` projection slots
   * instead, since overlay callers need exact control over badge styling
   * (error/success/dark tones) this generic pill list doesn't cover. */
  readonly badges = input<readonly string[]>([]);
  readonly selected = input<boolean>(false);
  readonly size = input<MuiMediaCellSize>('md');
  readonly layout = input<MuiMediaCellLayout>('stacked');
  readonly rating = model<number>(0);
  readonly flag = model<MuiRatingFlagState>('none');
  /** CSS `background-image` shown behind the thumbnail while `src` is
   * empty — forwarded to `mui-image`'s own `placeholderBackground` input
   * (the "not decoded yet" gradient state). */
  readonly placeholderBackground = input<string | null>(null);
  /** Reduced-opacity image, e.g. for a hidden/de-emphasized item. Dims
   * only the image layer — overlay badges and the rating/flags row stay
   * full-opacity on top of it, matching the source styling this replaces. */
  readonly dimmed = input<boolean>(false);
  /** Accessible name for the interactive cell — lands on the actual
   * button/div root (`[attr.aria-label]`), not the `<mui-media-cell>` host
   * tag, mirroring the `ariaLabel`/`ariaPressed` passthrough precedent
   * from `mui-tree-row`/`mui-button` (MW1/MW4). */
  readonly ariaLabel = input<string | null>(null);

  /** Fires on a click/tap of the thumbnail itself — not the rename field or
   * rating row, which own their own interactions. The caller decides what
   * a press means (select, open, toggle). Carries the originating
   * `MouseEvent` (native click, or a synthetic one for keyboard activation
   * of the `stacked` layout's non-native `role="button"` div) so a
   * multi-select caller can read modifier keys off it, the same contract
   * `asset-thumb`'s pre-migration `thumbClick` output already had. */
  readonly pressed = output<MouseEvent>();
  readonly renamed = output<string>();

  onCellClick(event: MouseEvent): void {
    this.pressed.emit(event);
  }

  /** `stacked` layout only — see the template. A `role="button"` div never
   * synthesizes its own Enter/Space activation the way a native `<button>`
   * does, so it needs this wired explicitly. `overlay` layout's root IS a
   * native `<button>` (no nested interactive descendants to worry about,
   * see the footer-slot doc on `layout`), so the browser's own
   * keyboard-to-click synthesis already covers it — binding this handler
   * there too would double-emit `pressed`. */
  onKeydown(event: KeyboardEvent): void {
    handleActivationKeydown(event, () => this.pressed.emit(new MouseEvent('click')));
  }
}
