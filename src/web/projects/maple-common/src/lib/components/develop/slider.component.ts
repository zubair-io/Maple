// Reusable labeled slider — label / numeric input / range input.

import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import { FormsModule } from '@angular/forms';

@Component({
  selector: 'editor-slider',
  standalone: true,
  imports: [FormsModule],
  host: { class: 'block' },
  templateUrl: './slider.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class EditorSliderComponent {
  label = input.required<string>();
  value = input.required<number>();
  min = input.required<number>();
  max = input.required<number>();
  step = input<number>(1);
  // NOTE: don't call this `change` — the inner <input> emits a native
  // `change` DOM event that bubbles up to the host, so any parent binding
  // `(change)="patch(..., $event)"` gets two firings: one with the DOM Event
  // (which wins last), one with the numeric payload. Result: the Event
  // object ends up stored as the adjustment value and the slider "does
  // nothing" visibly even though updateAdjustment is called.
  valueChange = output<number>();

  onChange(v: number): void {
    this.valueChange.emit(Number(v));
  }
}
