// paste-settings-dialog.component.ts — selective-paste UI for copy / paste
// / sync (#944). One checkbox per `ADJUSTMENT_GROUPS` entry; "Paste" emits
// the checked group ids, the caller builds + applies the patch via
// `buildGroupPatch`. Composes `mui-selective-paste-modal` (extended with
// `title`/`summary`/`allowBulkSelect` — the reference organism hardcoded a
// static title and had no select-all/none row) for the actual dialog chrome;
// this wrapper owns translating `ADJUSTMENT_GROUPS` into the modal's
// enabled-flag group list and keeps the same public API (`visible`/
// `targetCount`/`sourceLabel`/`paste`/`dismiss`) browse-shell already binds.

import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  input,
  output,
  signal,
} from '@angular/core';
import {
  MuiSelectivePasteModalComponent,
  type MuiSelectivePasteGroup,
} from '../../ui/selective-paste-modal/mui-selective-paste-modal.component';
import { ADJUSTMENT_GROUPS } from './adjustment-groups';
import type { AdjustmentGroupId } from './adjustment-groups';
import type { AdjustmentModel } from '../../models/adjustment-model';
import { groupValuePreview } from './group-value-preview';

function allEnabledGroups(): readonly MuiSelectivePasteGroup[] {
  return ADJUSTMENT_GROUPS.map((g) => ({ id: g.id, label: g.label, enabled: true }));
}

@Component({
  selector: 'app-paste-settings-dialog',
  standalone: true,
  imports: [MuiSelectivePasteModalComponent],
  templateUrl: './paste-settings-dialog.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PasteSettingsDialogComponent {
  // ── inputs / outputs ───────────────────────────────────────────────────
  readonly visible = input<boolean>(false);
  /** Number of assets the paste will apply to. */
  readonly targetCount = input<number>(0);
  /** Label of the asset the clipboard was copied from, for the header. */
  readonly sourceLabel = input<string>('');
  readonly sourceModel = input<AdjustmentModel | null>(null);
  readonly targetModels = input<readonly AdjustmentModel[] | null>(null);
  readonly previewError = input<string | null>(null);
  /** Emitted with the checked group ids when the user confirms. */
  readonly paste = output<readonly AdjustmentGroupId[]>();
  readonly dismiss = output<void>();

  protected readonly groups = signal<readonly MuiSelectivePasteGroup[]>(allEnabledGroups());
  protected readonly waitingForPreview = computed(
    () => this.sourceModel() !== null && this.targetModels() === null,
  );
  protected readonly previewGroups = computed(() => {
    const source = this.sourceModel();
    const targets = this.targetModels();
    if (!source || !targets) return this.groups();
    const previews = groupValuePreview(source, targets);
    return this.groups().map((group) => ({
      ...group,
      changes: previews[group.id as AdjustmentGroupId],
      description: previews[group.id as AdjustmentGroupId].length === 0 ? 'No changes' : undefined,
    }));
  });

  protected readonly summary = computed(() => {
    const count = this.targetCount();
    const status =
      this.previewError() ?? (this.waitingForPreview() ? 'Reading current settings…' : '');
    return `Paste from ${this.sourceLabel()} onto ${count} ${count === 1 ? 'photo' : 'photos'}. ${status}`.trim();
  });

  constructor() {
    // Every time the dialog opens, start from "everything selected" — the
    // common case is a full paste with a couple of groups unchecked, not
    // building a selection from scratch.
    effect(() => {
      if (this.visible()) {
        this.groups.set(allEnabledGroups());
      }
    });
  }

  onPasteConfirmed(ids: readonly string[]): void {
    if (ids.length === 0 || this.waitingForPreview() || this.previewError()) return;
    this.paste.emit(ids as readonly AdjustmentGroupId[]);
  }

  onDismissed(): void {
    this.dismiss.emit();
  }
}
