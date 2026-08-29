// MuiSettingsSection — Maple UI Organisms, Wave W6 Lane B "Configuration"
// (docs/unified-component-catalog.md §4.8). A titled group of related
// settings rows, built from SettingsRow, FormField, Divider, Banner.
//
// Rows come in two flavors, modeled as a discriminated union rather than a
// single row shape with optional fields: a `navigate` row hands off to
// another screen (rendered as a ListRow — the catalog's own doc comment
// calls ListRow "the base horizontal row primitive for settings rows"), and
// an `edit` row expands in place to reveal an inline FormField (rendered as
// a SettingsRow, whose Collapsible body is exactly that expand-to-edit
// affordance).

import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';
import type { MuiBannerVariant } from '../banner/mui-banner.component';
import { MuiBannerComponent } from '../banner/mui-banner.component';
import { MuiDividerComponent } from '../divider/mui-divider.component';
import { MuiFormFieldComponent } from '../form-field/mui-form-field.component';
import type { MapleIconName } from '../icon/mui-icon.component';
import { MuiIconComponent } from '../icon/mui-icon.component';
import { MuiListRowComponent } from '../list-row/mui-list-row.component';
import { MuiSettingsRowComponent } from '../settings-row/mui-settings-row.component';
import { MuiTextComponent } from '../text/mui-text.component';

export interface MuiSettingsSectionNavigableRow {
  readonly kind: 'navigate';
  readonly id: string;
  readonly label: string;
  readonly value?: string | null;
  readonly icon?: MapleIconName | null;
  readonly disabled?: boolean;
}

export interface MuiSettingsSectionEditableRow {
  readonly kind: 'edit';
  readonly id: string;
  readonly label: string;
  readonly description?: string | null;
  readonly icon?: MapleIconName | null;
  readonly value: string;
  readonly placeholder?: string;
  readonly help?: string | null;
}

export type MuiSettingsSectionRow = MuiSettingsSectionNavigableRow | MuiSettingsSectionEditableRow;

export interface MuiSettingsSectionBanner {
  readonly message: string;
  readonly variant: MuiBannerVariant;
}

export interface MuiSettingsSectionFieldChange {
  readonly id: string;
  readonly value: string;
}

/** Every optional field on {@link MuiSettingsSectionRow} normalized to a
 * concrete display value (the `?? null`/`?? false`/`?? ''` fallbacks each
 * row template previously carried inline) — moves that branching out of the
 * template and into one `computed()`, per-row, once. `raw` carries the
 * original row back to `onRowActivated`/`onFieldCommitted`, which need the
 * full discriminated-union type those handlers already accept. */
interface MuiSettingsSectionNavigateDisplayRow {
  readonly kind: 'navigate';
  readonly raw: MuiSettingsSectionNavigableRow;
  readonly label: string;
  readonly subtitle: string | null;
  readonly icon: MapleIconName | null;
  readonly disabled: boolean;
}

interface MuiSettingsSectionEditDisplayRow {
  readonly kind: 'edit';
  readonly raw: MuiSettingsSectionEditableRow;
  readonly label: string;
  readonly icon: MapleIconName | null;
  readonly description: string | null;
  readonly value: string;
  readonly placeholder: string;
  readonly help: string | null;
}

type MuiSettingsSectionDisplayRow =
  | MuiSettingsSectionNavigateDisplayRow
  | MuiSettingsSectionEditDisplayRow;

function toDisplayRow(row: MuiSettingsSectionRow): MuiSettingsSectionDisplayRow {
  if (row.kind === 'navigate') {
    return {
      kind: 'navigate',
      raw: row,
      label: row.label,
      subtitle: row.value ?? null,
      icon: row.icon ?? null,
      disabled: row.disabled ?? false,
    };
  }
  return {
    kind: 'edit',
    raw: row,
    label: row.label,
    icon: row.icon ?? null,
    description: row.description ?? null,
    value: row.value,
    placeholder: row.placeholder ?? '',
    help: row.help ?? null,
  };
}

@Component({
  selector: 'mui-settings-section',
  standalone: true,
  imports: [
    MuiBannerComponent,
    MuiDividerComponent,
    MuiFormFieldComponent,
    MuiIconComponent,
    MuiListRowComponent,
    MuiSettingsRowComponent,
    MuiTextComponent,
  ],
  templateUrl: './mui-settings-section.component.html',
  host: { class: 'block' },
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MuiSettingsSectionComponent {
  readonly title = input.required<string>();
  readonly rows = input.required<readonly MuiSettingsSectionRow[]>();
  readonly banner = input<MuiSettingsSectionBanner | null>(null);

  protected readonly displayRows = computed(() => this.rows().map(toDisplayRow));

  /** A navigable row was clicked — carries the row's `id`. */
  readonly rowActivated = output<string>();
  /** An editable row's inline FormField committed a new value. */
  readonly fieldChanged = output<MuiSettingsSectionFieldChange>();

  onRowActivated(row: MuiSettingsSectionNavigableRow): void {
    if (row.disabled) return;
    this.rowActivated.emit(row.id);
  }

  onFieldCommitted(row: MuiSettingsSectionEditableRow, value: string): void {
    this.fieldChanged.emit({ id: row.id, value });
  }
}
