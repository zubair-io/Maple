// MuiEventPopover — Maple UI Molecules-L2 (unified-component-catalog.md
// §3). Calendar event create/edit, built from Popover, Form Field, Button.

import { ChangeDetectionStrategy, Component, input, model, output } from '@angular/core';
import { MuiButtonComponent } from '../button/mui-button.component';
import { MuiFormFieldComponent } from '../form-field/mui-form-field.component';
import { MuiPopoverComponent } from '../popover/mui-popover.component';
import type { MuiPopoverPlacement } from '../popover/mui-popover.component';

@Component({
  selector: 'mui-event-popover',
  standalone: true,
  imports: [MuiButtonComponent, MuiFormFieldComponent, MuiPopoverComponent],
  templateUrl: './mui-event-popover.component.html',
  styleUrl: './mui-event-popover.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MuiEventPopoverComponent {
  readonly open = input<boolean>(false);
  readonly placement = input<MuiPopoverPlacement>('bottom');
  readonly title = model<string>('');
  readonly timeLabel = model<string>('');

  readonly closeRequested = output<void>();
  readonly saved = output<void>();
  readonly deleted = output<void>();

  save(): void {
    this.saved.emit();
  }

  // Named `deleteEvent`, not `delete` — `delete` is a reserved JS/TS
  // operator keyword, and using it as a method name here caused a static
  // analysis tool to fail to resolve the template's call site (flagged as
  // "unused") even though Angular's own template compiler handled it fine.
  deleteEvent(): void {
    this.deleted.emit();
  }
}
