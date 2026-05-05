// Reusable labeled slider — label / numeric input / range input.

import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import { FormsModule } from '@angular/forms';

@Component({
  selector: 'editor-slider',
  standalone: true,
  imports: [FormsModule],
  host: { class: 'block' },
  template: `
    <div class="flex items-center gap-1.5 px-3.5 py-[3px] min-h-[26px]">
      <label
        class="grow-0 shrink-0 basis-20 text-[11px] text-text-muted whitespace-nowrap overflow-hidden text-ellipsis"
        [title]="label()"
      >{{ label() }}</label>
      <input
        type="range"
        class="flex-1 min-w-0 accent-primary cursor-pointer h-4"
        [ngModel]="value()"
        (ngModelChange)="onChange($event)"
        [min]="min()"
        [max]="max()"
        [step]="step()"
      />
      <input
        type="number"
        class="w-[42px] h-5 bg-input-bg border-[0.5px] border-border rounded-[3px] px-1 font-mono text-[10px] text-text-main text-right outline-none box-border shrink-0 focus:border-primary"
        [ngModel]="value()"
        (ngModelChange)="onChange($event)"
        [min]="min()"
        [max]="max()"
        [step]="step()"
      />
    </div>
  `,
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
