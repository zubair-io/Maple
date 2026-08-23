// MuiBotOutput — Maple UI Molecules-L2 (unified-component-catalog.md §3).
// Streaming generated result, built from Text, Progress, Avatar.
//
// Streaming timer: driven by a plain `setInterval`, matching the existing
// timer convention in this library (mui-toast's auto-dismiss). Specs make it
// deterministic with vitest's fake timers (`vi.useFakeTimers()` +
// `vi.advanceTimersByTime`) rather than real wall-clock waits, same as
// mui-toast.component.spec.ts.

import {
  ChangeDetectionStrategy,
  Component,
  OnChanges,
  OnDestroy,
  SimpleChanges,
  computed,
  input,
  output,
  signal,
} from '@angular/core';
import { MuiAvatarComponent } from '../avatar/mui-avatar.component';
import { MuiProgressComponent } from '../progress/mui-progress.component';
import { MuiTextComponent } from '../text/mui-text.component';

@Component({
  selector: 'mui-bot-output',
  standalone: true,
  imports: [MuiAvatarComponent, MuiProgressComponent, MuiTextComponent],
  templateUrl: './mui-bot-output.component.html',
  styleUrl: './mui-bot-output.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MuiBotOutputComponent implements OnChanges, OnDestroy {
  readonly text = input.required<string>();
  /** When true, `text` is revealed progressively rather than shown whole. */
  readonly streaming = input<boolean>(false);
  readonly botName = input<string>('Maple AI');
  /** Characters revealed per tick. */
  readonly charsPerTick = input<number>(2);
  readonly intervalMs = input<number>(30);

  /** Fires once when the full `text` has been revealed. */
  readonly completed = output<void>();

  readonly visibleLength = signal(0);

  readonly visibleText = computed(() => this.text().slice(0, this.visibleLength()));
  readonly isRevealing = computed(
    () => this.streaming() && this.visibleLength() < this.text().length,
  );

  private tickTimer: ReturnType<typeof setInterval> | null = null;

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['text'] || changes['streaming']) {
      this.clearTimer();
      if (this.streaming()) {
        this.visibleLength.set(0);
        this.scheduleTick();
      } else {
        this.visibleLength.set(this.text().length);
      }
    }
  }

  ngOnDestroy(): void {
    this.clearTimer();
  }

  private scheduleTick(): void {
    this.tickTimer = setInterval(() => {
      const next = Math.min(this.text().length, this.visibleLength() + this.charsPerTick());
      this.visibleLength.set(next);
      if (next >= this.text().length) {
        this.clearTimer();
        this.completed.emit();
      }
    }, this.intervalMs());
  }

  private clearTimer(): void {
    if (this.tickTimer !== null) clearInterval(this.tickTimer);
    this.tickTimer = null;
  }
}
