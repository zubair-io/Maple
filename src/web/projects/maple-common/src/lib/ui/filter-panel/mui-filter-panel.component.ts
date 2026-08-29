// MuiFilterPanel — the Maple UI design-system Filter Panel organism
// (unified-component-catalog.md §4.2; Built from: Collapsible, Chip Row,
// Checkbox, Form Field). Faceted multi-select filters: one collapsible
// group per facet holding a checkbox list (optionally narrowed by a
// per-group free-text filter), plus a summary chip row of the filters
// currently applied. Only the first group starts open, to avoid a wall of
// expanded checkboxes on first render.

import {
  ChangeDetectionStrategy,
  Component,
  effect,
  input,
  output,
  signal,
  untracked,
} from '@angular/core';
import { MuiCheckboxComponent } from '../checkbox/mui-checkbox.component';
import type { MuiChip } from '../chip-row/mui-chip-row.component';
import { MuiChipRowComponent } from '../chip-row/mui-chip-row.component';
import { MuiCollapsibleComponent } from '../collapsible/mui-collapsible.component';
import { MuiEmptyStateComponent } from '../empty-state/mui-empty-state.component';
import { MuiFormFieldComponent } from '../form-field/mui-form-field.component';
import { toggleId } from '../internal/id-list';

export interface MuiFilterOption {
  readonly id: string;
  readonly label: string;
  readonly checked: boolean;
}

export interface MuiFilterGroup {
  readonly id: string;
  readonly label: string;
  readonly options: readonly MuiFilterOption[];
  readonly searchable?: boolean;
}

@Component({
  selector: 'mui-filter-panel',
  standalone: true,
  imports: [
    MuiCheckboxComponent,
    MuiChipRowComponent,
    MuiCollapsibleComponent,
    MuiEmptyStateComponent,
    MuiFormFieldComponent,
  ],
  templateUrl: './mui-filter-panel.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block' },
})
export class MuiFilterPanelComponent {
  readonly groups = input.required<readonly MuiFilterGroup[]>();
  /** Summary row of currently-applied filters — independent of the
   * per-group checkbox lists below. */
  readonly activeChips = input<readonly MuiChip[]>([]);
  readonly emptyMessage = input<string>('No filters available.');

  readonly optionToggled = output<{ groupId: string; optionId: string; checked: boolean }>();
  readonly chipRemoved = output<string>();

  readonly openGroupIds = signal<readonly string[]>([]);
  readonly groupSearchDrafts = signal<Readonly<Record<string, string>>>({});

  constructor() {
    effect(() => {
      const groups = this.groups();
      if (untracked(() => this.openGroupIds().length) === 0 && groups.length > 0) {
        this.openGroupIds.set([groups[0].id]);
      }
    });
  }

  toggleGroup(id: string, isOpen: boolean): void {
    this.openGroupIds.update((ids) => toggleId(ids, id, isOpen));
  }

  setGroupSearch(groupId: string, value: string): void {
    this.groupSearchDrafts.update((drafts) => ({ ...drafts, [groupId]: value }));
  }

  visibleOptions(group: MuiFilterGroup): readonly MuiFilterOption[] {
    const draft = (this.groupSearchDrafts()[group.id] ?? '').trim();
    if (!group.searchable || draft.length === 0) return group.options;
    const needle = draft.toLowerCase();
    return group.options.filter((option) => option.label.toLowerCase().includes(needle));
  }
}
