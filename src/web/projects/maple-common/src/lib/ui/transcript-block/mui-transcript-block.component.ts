// MuiTranscriptBlock — Maple UI Molecules-L2 (unified-component-catalog.md
// §3). Timestamped read-only transcript, built from Text, Timestamp. Each
// entry's time code is expressed as an offset (ms) from `baseTime`, rendered
// through the real Timestamp atom (`time-only` format) rather than a
// hand-rolled mm:ss formatter — a genuine composition, not a lookalike.

import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { MuiTextComponent } from '../text/mui-text.component';
import { MuiTimestampComponent } from '../timestamp/mui-timestamp.component';

export interface MuiTranscriptEntry {
  readonly id: string;
  /** Milliseconds from `baseTime` this line was spoken. */
  readonly offsetMs: number;
  readonly speaker?: string;
  readonly text: string;
}

@Component({
  selector: 'mui-transcript-block',
  standalone: true,
  imports: [MuiTextComponent, MuiTimestampComponent],
  templateUrl: './mui-transcript-block.component.html',
  host: { class: 'block' },
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MuiTranscriptBlockComponent {
  readonly baseTime = input.required<Date | number>();
  readonly entries = input.required<readonly MuiTranscriptEntry[]>();

  entryTime(entry: MuiTranscriptEntry): number {
    const base = this.baseTime();
    const baseMs = base instanceof Date ? base.getTime() : base;
    return baseMs + entry.offsetMs;
  }
}
