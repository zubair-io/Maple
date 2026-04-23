// Reusable labeled slider — label / numeric input / range input.

import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import { FormsModule } from '@angular/forms';

@Component({
  selector: 'editor-slider',
  standalone: true,
  imports: [FormsModule],
  styles: [
    `
      :host {
        display: block;
      }

      .slider-row {
        display: flex;
        align-items: center;
        gap: 6px;
        padding: 3px 14px;
        min-height: 26px;
      }

      label {
        flex: 0 0 80px;
        font-family: var(--maple-font);
        font-size: 11px;
        color: var(--maple-text-muted);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }

      input[type='number'] {
        width: 42px;
        height: 20px;
        background: var(--maple-input-bg);
        border: 0.5px solid var(--maple-border);
        border-radius: 3px;
        padding: 0 4px;
        font-family: var(--maple-font-mono);
        font-size: 10px;
        color: var(--maple-text-main);
        text-align: right;
        outline: none;
        box-sizing: border-box;
        flex-shrink: 0;
      }
      input[type='number']:focus {
        border-color: var(--maple-primary);
      }

      input[type='range'] {
        flex: 1;
        min-width: 0;
        accent-color: var(--maple-primary);
        cursor: pointer;
        height: 16px;
      }
    `,
  ],
  template: `
    <div class="slider-row">
      <label [title]="label()">{{ label() }}</label>
      <input
        type="range"
        [ngModel]="value()"
        (ngModelChange)="onChange($event)"
        [min]="min()"
        [max]="max()"
        [step]="step()"
      />
      <input
        type="number"
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
  change = output<number>();

  onChange(v: number): void {
    this.change.emit(Number(v));
  }
}
