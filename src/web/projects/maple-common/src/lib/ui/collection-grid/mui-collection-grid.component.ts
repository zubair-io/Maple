// MuiCollectionGrid — Maple UI Organisms · Collections
// (unified-component-catalog.md §4.1). Virtualized selectable thumbnail
// grid, built from Media Cell, Empty State, Spinner, Drag Preview.
//
// Virtualization is deliberately "lite" rather than CDK-backed: the caller
// supplies a fixed `columns` count and a per-row `cellHeight` instead of
// this component measuring itself, so the windowing math is a handful of
// pure `computed()`s over `scrollTop` — deterministic and easy to exercise
// in jsdom, where there is no real layout engine to measure against.
//
// Multi-select follows the familiar file-manager contract: a plain click
// replaces the selection and sets the shift-click anchor; Cmd/Ctrl-click
// toggles one item; Shift-click selects the contiguous range from the last
// anchor. Drag start promotes a single un-selected item to a one-item
// selection (so dragging an unselected thumbnail doesn't drag the whole
// prior selection with it) before starting the HTML5 drag payload.

import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
  model,
  output,
  signal,
} from '@angular/core';
import { MuiDragPreviewComponent } from '../drag-preview/mui-drag-preview.component';
import { MuiEmptyStateComponent } from '../empty-state/mui-empty-state.component';
import { MuiMediaCellComponent } from '../media-cell/mui-media-cell.component';
import type { MuiRatingFlagState } from '../rating-flags/mui-rating-flags.component';
import { MuiSpinnerComponent } from '../spinner/mui-spinner.component';

export interface MuiCollectionItem {
  readonly id: string;
  readonly src: string;
  readonly alt: string;
  readonly filename?: string;
  readonly badges?: readonly string[];
  readonly rating?: number;
  readonly flag?: MuiRatingFlagState;
}

@Component({
  selector: 'mui-collection-grid',
  standalone: true,
  imports: [
    MuiDragPreviewComponent,
    MuiEmptyStateComponent,
    MuiMediaCellComponent,
    MuiSpinnerComponent,
  ],
  templateUrl: './mui-collection-grid.component.html',
  styleUrl: './mui-collection-grid.component.scss',
  host: { class: 'block relative' },
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MuiCollectionGridComponent {
  readonly items = input.required<readonly MuiCollectionItem[]>();
  readonly loading = input<boolean>(false);
  readonly error = input<string | null>(null);
  readonly emptyMessage = input<string>('No items to show.');
  /** Caller-specified column count — not measured via ResizeObserver, so
   * the windowing math below stays pure and testable. */
  readonly columns = input<number>(4);
  /** Px per row, including gap — must match the caller's actual layout for
   * the virtualization window to line up with what's really rendered. */
  readonly cellHeight = input<number>(140);
  readonly viewportHeight = input<number>(480);
  readonly bufferRows = input<number>(2);

  readonly selectedIds = model<readonly string[]>([]);

  /** Fires on a double-click or Enter/Space activation of a cell. */
  readonly opened = output<string>();
  readonly dragStarted = output<readonly string[]>();

  private readonly scrollTop = signal(0);
  /** Shift-click range anchor — not itself part of the public selection
   * contract, so it's a plain signal rather than a model. */
  private readonly anchorId = signal<string | null>(null);

  protected readonly draggingIds = signal<readonly string[]>([]);
  protected readonly dragPreviewPos = signal<{ x: number; y: number } | null>(null);

  protected readonly totalRows = computed(() => Math.ceil(this.items().length / this.columns()));

  protected readonly startRow = computed(() =>
    Math.max(0, Math.floor(this.scrollTop() / this.cellHeight()) - this.bufferRows()),
  );

  protected readonly endRow = computed(() =>
    Math.min(
      this.totalRows(),
      Math.ceil((this.scrollTop() + this.viewportHeight()) / this.cellHeight()) + this.bufferRows(),
    ),
  );

  protected readonly visibleItems = computed(() =>
    this.items().slice(this.startRow() * this.columns(), this.endRow() * this.columns()),
  );

  /** {@link visibleItems}, with every `mui-media-cell` binding's `?? ...`
   * fallback and the `selectedIds().includes(...)` lookup resolved once
   * here instead of inline per-binding in the template. `raw` carries the
   * original item back to `onDragStart`, which needs the full item (for a
   * click-to-drag single-select promotion), not just the display fields. */
  protected readonly visibleDisplayItems = computed(() => {
    const selected = new Set(this.selectedIds());
    return this.visibleItems().map((item) => ({
      id: item.id,
      raw: item,
      src: item.src,
      alt: item.alt,
      filename: item.filename ?? '',
      badges: item.badges ?? [],
      rating: item.rating ?? 0,
      flag: item.flag ?? 'none',
      selected: selected.has(item.id),
    }));
  });

  protected readonly topSpacerPx = computed(() => this.startRow() * this.cellHeight());

  protected readonly bottomSpacerPx = computed(() =>
    Math.max(0, (this.totalRows() - this.endRow()) * this.cellHeight()),
  );

  protected readonly gridTemplateColumns = computed(() => `repeat(${this.columns()}, 1fr)`);

  /** Everything the drag-ghost preview needs, or `null` when there's
   * nothing to show — folds the three separate conditions the template
   * previously nested (`draggingIds().length > 0`, a live pointer position,
   * and a resolvable source thumbnail) into one signal so the template
   * needs only a single `@if`. */
  protected readonly dragGhost = computed(() => {
    const ids = this.draggingIds();
    if (ids.length === 0) return null;
    const pos = this.dragPreviewPos();
    if (!pos) return null;
    const src = this.items().find((item) => item.id === ids[0])?.src;
    if (!src) return null;
    return { src, count: ids.length, x: pos.x, y: pos.y };
  });

  onScroll(event: Event): void {
    this.scrollTop.set((event.target as HTMLElement).scrollTop);
  }

  onCellClick(id: string, event: MouseEvent): void {
    const anchor = this.anchorId();
    if (event.shiftKey && anchor !== null) {
      this.selectRange(anchor, id);
      return;
    }
    if (event.metaKey || event.ctrlKey) {
      this.toggleSelection(id);
      return;
    }
    this.selectedIds.set([id]);
    this.anchorId.set(id);
  }

  /** Bound to `mui-media-cell`'s own `pressed` output (mouse click, and
   * Enter/Space via its internal keydown handler) so the cell stays
   * keyboard-operable — no modifier keys are observable from that output,
   * so this is always a plain single-select. A real mouse click also
   * bubbles into `onCellClick` on the wrapper afterward, which — running
   * second — has the final say once modifier keys are in play. */
  onCellPressed(id: string): void {
    this.selectedIds.set([id]);
    this.anchorId.set(id);
  }

  onCellDblClick(id: string): void {
    this.opened.emit(id);
  }

  onDragStart(item: MuiCollectionItem, event: DragEvent): void {
    if (!this.selectedIds().includes(item.id)) {
      this.selectedIds.set([item.id]);
      this.anchorId.set(item.id);
    }
    this.draggingIds.set(this.selectedIds());
    event.dataTransfer?.setDragImage(new Image(), 0, 0);
    if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
    this.dragStarted.emit(this.draggingIds());
  }

  onDrag(event: DragEvent): void {
    // The final `drag` event just before `dragend` reports (0, 0) in most
    // browsers — ignore it so the ghost doesn't jump to the corner.
    if (event.clientX === 0 && event.clientY === 0) return;
    this.dragPreviewPos.set({ x: event.clientX, y: event.clientY });
  }

  onDragEnd(): void {
    this.draggingIds.set([]);
    this.dragPreviewPos.set(null);
  }

  private selectRange(anchorId: string, id: string): void {
    const ids = this.items().map((item) => item.id);
    const anchorIndex = ids.indexOf(anchorId);
    const targetIndex = ids.indexOf(id);
    if (anchorIndex === -1 || targetIndex === -1) {
      this.selectedIds.set([id]);
      return;
    }
    const [start, end] =
      anchorIndex <= targetIndex ? [anchorIndex, targetIndex] : [targetIndex, anchorIndex];
    this.selectedIds.set(ids.slice(start, end + 1));
  }

  private toggleSelection(id: string): void {
    const current = this.selectedIds();
    const next = current.includes(id)
      ? current.filter((existing) => existing !== id)
      : [...current, id];
    this.selectedIds.set(next);
  }
}
