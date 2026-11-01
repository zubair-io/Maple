// MuiToggle — the Maple UI design-system Toggle atom
// (docs/design/maple-ui/components/toggle.md). A single immediate-effect on/off
// switch: a native `<button role="switch">`, so the platform announces the
// state change itself. A change that needs a separate Save belongs in a
// Checkbox instead.

import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';

@Component({
  selector: 'mui-toggle',
  standalone: true,
  templateUrl: './mui-toggle.component.html',
  host: { class: 'inline-flex' },
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MuiToggleComponent {
  readonly checked = input<boolean>(false);
  /** Almost every toggle is labeled; pass `ariaLabel` when it genuinely isn't. */
  readonly label = input<string | null>(null);
  readonly ariaLabel = input<string | null>(null);
  /** Id of an element that describes the switch, such as a helper line beside it. */
  readonly ariaDescribedBy = input<string | null>(null);
  readonly disabled = input<boolean>(false);

  readonly checkedChange = output<boolean>();

  // fallow-ignore-next-line unused-class-member -- bound from the templateUrl view.
  onClick(): void {
    this.checkedChange.emit(!this.checked());
  }
}
