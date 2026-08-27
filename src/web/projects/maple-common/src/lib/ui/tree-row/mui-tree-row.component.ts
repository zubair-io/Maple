// MuiTreeRow — Maple UI Molecules-L1 (unified-component-catalog.md §2.2).
// One row of a hierarchical tree, built from Icon, Text, Badge, Spinner.

import { ChangeDetectionStrategy, Component, computed, input, model, output } from '@angular/core';
import { MuiBadgeComponent } from '../badge/mui-badge.component';
import { MuiIconComponent } from '../icon/mui-icon.component';
import type { MapleIconName } from '../icon/mui-icon.component';
import { MuiSpinnerComponent } from '../spinner/mui-spinner.component';
import { MuiTextComponent } from '../text/mui-text.component';
import { handleActivationKeydown } from '../internal/activation-keydown';
import { MuiTreeRowChevronComponent } from './mui-tree-row-chevron.component';

@Component({
  selector: 'mui-tree-row',
  standalone: true,
  imports: [
    MuiBadgeComponent,
    MuiIconComponent,
    MuiSpinnerComponent,
    MuiTextComponent,
    MuiTreeRowChevronComponent,
  ],
  templateUrl: './mui-tree-row.component.html',
  styleUrl: './mui-tree-row.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MuiTreeRowComponent {
  readonly label = input.required<string>();
  /** Overrides the treeitem's accessible name when the visible `label` text
   * alone doesn't disambiguate the row (e.g. "Trash — My Library" across
   * several registered libraries) — otherwise the name derives implicitly
   * from the rendered label + count text. */
  readonly ariaLabel = input<string | null>(null);
  readonly icon = input<MapleIconName>('folder');
  /** `'primary'` (the default) always tints the leading icon
   * `--color-primary`, matching the original reference look. `'active-only'`
   * keeps it muted (`--color-text-muted`) except while `active` is true —
   * the folder-tree's pre-migration look, where only the selected row's
   * icon picked up the accent color (MW4, ticket #3031). */
  readonly iconColor = input<'primary' | 'active-only'>('primary');
  /** Shows a leading chevron and toggles `expanded` when there are children. */
  readonly expandable = input<boolean>(false);
  readonly expanded = model<boolean>(false);
  /** Indentation level — each level adds one indent unit. */
  readonly depth = input<number>(0);
  /** A pre-formatted string is accepted alongside a plain number so a
   * caller that needs locale/thousands formatting (e.g. `DecimalPipe`) can
   * format it once itself rather than mui-tree-row losing that formatting
   * on migration (MW4, ticket #3031). */
  readonly count = input<number | string | null>(null);
  readonly loading = input<boolean>(false);
  /** Busy state for the CHEVRON slot itself (e.g. a folder's children are
   * still loading over the network) — distinct from `loading`, which
   * replaces the trailing count badge instead. Only rendered when
   * `expandable` is true. */
  readonly expandBusy = input<boolean>(false);
  /** Error state for the chevron slot (e.g. a folder's children failed to
   * load) — renders a small error glyph in place of the chevron; clicking
   * it toggles `expanded` exactly like the normal chevron, so a caller can
   * retry a failed expand the same way it would open a fresh one. */
  readonly expandError = input<boolean>(false);
  readonly errorTitle = input<string | undefined>(undefined);
  readonly active = input<boolean>(false);
  readonly disabled = input<boolean>(false);
  /** Forwarded to the real treeitem element's `aria-haspopup` (e.g. a row
   * with a right-click/keyboard context menu) — an attribute bound
   * directly on `<mui-tree-row>` would land on this component's own host
   * tag rather than the inner treeitem div, same reasoning as MuiButton's
   * `ariaExpanded`/`ariaPressed` passthroughs. */
  readonly ariaHasPopup = input<'menu' | 'listbox' | 'true' | null>(null);

  readonly pressed = output<void>();

  readonly indentPx = computed(() => this.depth() * 16);
  readonly isIconMuted = computed(() => this.iconColor() === 'active-only' && !this.active());

  toggle(event: Event): void {
    event.stopPropagation();
    if (this.disabled()) return;
    this.expanded.set(!this.expanded());
  }

  onRowClick(): void {
    if (this.disabled()) return;
    this.pressed.emit();
  }

  /** Enter/Space activates the row like a click — but only when the key
   * event originated on the row itself, not bubbled up from the nested
   * chevron `<button>`, which already handles its own Enter/Space via the
   * browser's native button-activation behavior (MW4, ticket #3031 — the
   * migrated `TrashNodeRowComponent` explicitly supported this and would
   * otherwise have regressed). */
  onKeydown(event: KeyboardEvent): void {
    if (event.target !== event.currentTarget) return;
    if (this.disabled()) return;
    handleActivationKeydown(event, () => this.pressed.emit());
  }
}
