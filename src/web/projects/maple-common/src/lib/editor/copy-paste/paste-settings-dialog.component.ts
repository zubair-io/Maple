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
import { MuiCheckboxComponent } from '../../ui/checkbox/mui-checkbox.component';
import {
  relativeWhiteBalanceDescription,
  whiteBalanceCorrection,
  type WhiteBalanceBaseline,
} from './adjustment-transfer';
import { groupValuePreview } from './group-value-preview';

function allEnabledGroups(): readonly MuiSelectivePasteGroup[] {
  return ADJUSTMENT_GROUPS.map((g) => ({ id: g.id, label: g.label, enabled: true }));
}

@Component({
  selector: 'app-paste-settings-dialog',
  standalone: true,
  imports: [MuiSelectivePasteModalComponent, MuiCheckboxComponent],
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
  readonly paste = output<{
    groups: readonly AdjustmentGroupId[];
    relativeWhiteBalance: boolean;
    sourceBaseline?: WhiteBalanceBaseline;
  }>();
  readonly readSourceBaseline = input<(() => Promise<WhiteBalanceBaseline>) | null>(null);
  protected readonly relativeWhiteBalance = signal(false);
  protected readonly baseline = signal<WhiteBalanceBaseline | undefined>(undefined);
  protected readonly baselineError = signal<string | null>(null);
  protected readonly readingBaseline = signal(false);
  private baselineGeneration = 0;
  protected readonly relativeBlocked = computed(
    () =>
      this.relativeWhiteBalance() &&
      this.groups().some((g) => g.id === 'white_balance' && g.enabled) &&
      (this.readingBaseline() || this.baselineError() !== null || !this.baseline()),
  );
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
    const relative = this.relativeWhiteBalance()
      ? relativeWhiteBalanceDescription(
          {
            source,
            groups: ['white_balance'],
            relativeWhiteBalance: true,
            sourceBaseline: this.baseline(),
          },
          targets,
        )
      : null;
    return this.groups().map((group) => ({
      ...group,
      changes:
        relative && group.id === 'white_balance' ? [] : previews[group.id as AdjustmentGroupId],
      description:
        relative && group.id === 'white_balance'
          ? relative
          : previews[group.id as AdjustmentGroupId].length === 0
            ? 'No changes'
            : undefined,
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
        this.relativeWhiteBalance.set(false);
        this.baseline.set(undefined);
        this.baselineError.set(null);
        this.readingBaseline.set(false);
        ++this.baselineGeneration;
      }
    });
  }

  onPasteConfirmed(ids: readonly string[]): void {
    if (
      ids.length === 0 ||
      this.waitingForPreview() ||
      this.previewError() ||
      this.relativeBlocked()
    )
      return;
    this.paste.emit({
      groups: ids as readonly AdjustmentGroupId[],
      relativeWhiteBalance: this.relativeWhiteBalance(),
      sourceBaseline: this.baseline(),
    });
  }

  async setRelative(enabled: boolean): Promise<void> {
    this.relativeWhiteBalance.set(enabled);
    const generation = ++this.baselineGeneration;
    if (!enabled) {
      this.readingBaseline.set(false);
      return;
    }
    this.readingBaseline.set(true);
    this.baselineError.set(null);
    try {
      const read = this.readSourceBaseline();
      if (!read) throw new Error('Copy the source photo again to read its camera white balance.');
      const baseline = await read();
      const source = this.sourceModel();
      if (!source) throw new Error('Copy the source photo again.');
      whiteBalanceCorrection({
        source,
        groups: ['white_balance'],
        relativeWhiteBalance: true,
        sourceBaseline: baseline,
      });
      if (generation === this.baselineGeneration) this.baseline.set(baseline);
    } catch (error) {
      if (generation === this.baselineGeneration)
        this.baselineError.set(error instanceof Error ? error.message : String(error));
    } finally {
      if (generation === this.baselineGeneration) this.readingBaseline.set(false);
    }
  }

  onDismissed(): void {
    this.dismiss.emit();
  }
}
