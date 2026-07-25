// paste-settings-dialog.component.ts — selective-paste UI for copy / paste
// / sync (#944). One checkbox per `ADJUSTMENT_GROUPS` entry; "Paste" emits
// the checked group ids, the caller builds + applies the patch via
// `buildGroupPatch`. Modeled on `PanoDialogComponent`'s dialog-hosting
// pattern (visible/dismiss over a backdrop, parent owns open/close state).

import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  input,
  output,
  signal,
} from '@angular/core';
import { ADJUSTMENT_GROUPS, ALL_ADJUSTMENT_GROUP_IDS } from './adjustment-groups';
import type { AdjustmentGroupId } from './adjustment-groups';

@Component({
  selector: 'app-paste-settings-dialog',
  standalone: true,
  templateUrl: './paste-settings-dialog.component.html',
  styleUrl: './paste-settings-dialog.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PasteSettingsDialogComponent {
  // ── inputs / outputs ───────────────────────────────────────────────────
  readonly visible = input<boolean>(false);
  /** Number of assets the paste will apply to. */
  readonly targetCount = input<number>(0);
  /** Label of the asset the clipboard was copied from, for the header. */
  readonly sourceLabel = input<string>('');
  /** Emitted with the checked group ids when the user confirms. */
  readonly paste = output<readonly AdjustmentGroupId[]>();
  readonly dismiss = output<void>();

  readonly groups = ADJUSTMENT_GROUPS;

  private readonly _selected = signal<ReadonlySet<AdjustmentGroupId>>(
    new Set(ALL_ADJUSTMENT_GROUP_IDS),
  );

  readonly allSelected = computed(() => this._selected().size === this.groups.length);
  readonly noneSelected = computed(() => this._selected().size === 0);

  constructor() {
    // Every time the dialog opens, start from "everything selected" — the
    // common case is a full paste with a couple of groups unchecked, not
    // building a selection from scratch.
    effect(() => {
      if (this.visible()) {
        this._selected.set(new Set(ALL_ADJUSTMENT_GROUP_IDS));
      }
    });
  }

  isChecked(id: AdjustmentGroupId): boolean {
    return this._selected().has(id);
  }

  toggleGroup(id: AdjustmentGroupId): void {
    this._selected.update((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }

  selectAll(): void {
    this._selected.set(new Set(ALL_ADJUSTMENT_GROUP_IDS));
  }

  selectNone(): void {
    this._selected.set(new Set());
  }

  onPasteClick(): void {
    const selected = this._selected();
    if (selected.size === 0) return;
    this.paste.emit([...selected]);
  }

  onCancel(): void {
    this.dismiss.emit();
  }

  onBackdropClick(): void {
    this.dismiss.emit();
  }
}
