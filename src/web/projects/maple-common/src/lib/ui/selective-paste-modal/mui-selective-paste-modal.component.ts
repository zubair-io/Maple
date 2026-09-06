// MuiSelectivePasteModal — Maple UI Organisms (unified-component-catalog.md
// §4.4). Per-group apply toggles before pasting settings onto other photos,
// built from Overlay Shell, Checkbox (repeated per group), Text, and
// Button.

import { ChangeDetectionStrategy, Component, computed, input, model, output } from '@angular/core';
import { MuiButtonComponent } from '../button/mui-button.component';
import { MuiCheckboxComponent } from '../checkbox/mui-checkbox.component';
import { MuiOverlayShellComponent } from '../overlay-shell/mui-overlay-shell.component';
import { MuiTextComponent } from '../text/mui-text.component';

export interface MuiSelectivePasteGroup {
  readonly id: string;
  readonly label: string;
  readonly description?: string;
  readonly enabled: boolean;
  readonly changes?: readonly {
    field: string;
    before: string;
    after: string;
    changedCount: number;
  }[];
}

@Component({
  selector: 'mui-selective-paste-modal',
  standalone: true,
  imports: [MuiButtonComponent, MuiCheckboxComponent, MuiOverlayShellComponent, MuiTextComponent],
  templateUrl: './mui-selective-paste-modal.component.html',
  host: { class: 'contents' },
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MuiSelectivePasteModalComponent {
  readonly open = input<boolean>(false);
  readonly groups = model.required<readonly MuiSelectivePasteGroup[]>();
  readonly title = input<string>('Selective Paste');
  /** Optional line under the title, e.g. "Paste from A onto 3 photos." */
  readonly summary = input<string | null>(null);
  /** Select-all/none bulk row above the group list. */
  readonly allowBulkSelect = input<boolean>(true);
  readonly confirmDisabled = input(false);

  /** Fires with the ids of the groups left enabled when Paste is pressed. */
  readonly pasteConfirmed = output<readonly string[]>();
  readonly dismissed = output<void>();

  readonly enabledCount = computed(() => this.groups().filter((group) => group.enabled).length);
  readonly allSelected = computed(
    () => this.groups().length > 0 && this.enabledCount() === this.groups().length,
  );
  readonly noneSelected = computed(() => this.enabledCount() === 0);

  toggleGroup(groupId: string, enabled: boolean): void {
    this.groups.set(
      this.groups().map((group) => (group.id === groupId ? { ...group, enabled } : group)),
    );
  }

  selectAll(): void {
    this.groups.set(this.groups().map((group) => ({ ...group, enabled: true })));
  }

  selectNone(): void {
    this.groups.set(this.groups().map((group) => ({ ...group, enabled: false })));
  }

  confirmPaste(): void {
    if (this.confirmDisabled() || this.noneSelected()) return;
    this.pasteConfirmed.emit(
      this.groups()
        .filter((group) => group.enabled)
        .map((group) => group.id),
    );
  }
}
