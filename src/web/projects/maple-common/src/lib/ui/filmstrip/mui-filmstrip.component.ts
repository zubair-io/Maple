// MuiFilmstrip — Maple UI Organisms · Collections
// (unified-component-catalog.md §4.1). Focus-following thumbnail strip,
// built from Filmstrip Row, Filmstrip Rail — a thin orientation switcher
// between the two, plus the "focus-following" behavior neither owns on its
// own: whenever `activeId` changes, scroll the now-active cell into view.
//
// Filmstrip Row/Rail already degrade gracefully to an empty strip with no
// items, so this organism adds no loading/empty/error chrome of its own —
// doing so would just duplicate what the children already handle.

import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  effect,
  inject,
  input,
  model,
  output,
} from '@angular/core';
import { MuiFilmstripRailComponent } from '../filmstrip-rail/mui-filmstrip-rail.component';
import { MuiFilmstripRowComponent } from '../filmstrip-row/mui-filmstrip-row.component';
import type { MuiFilmstripItem } from '../filmstrip-row/mui-filmstrip-row.component';

export type MuiFilmstripOrientation = 'horizontal' | 'vertical';

@Component({
  selector: 'mui-filmstrip',
  standalone: true,
  imports: [MuiFilmstripRailComponent, MuiFilmstripRowComponent],
  templateUrl: './mui-filmstrip.component.html',
  styleUrl: './mui-filmstrip.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MuiFilmstripComponent {
  readonly items = input.required<readonly MuiFilmstripItem[]>();
  readonly orientation = input<MuiFilmstripOrientation>('horizontal');

  readonly activeId = model<string | null>(null);
  /** Only meaningful in `vertical` orientation — forwarded to Filmstrip
   * Rail, which owns the actual collapse toggle. */
  readonly collapsed = model<boolean>(false);

  readonly activated = output<string>();

  private readonly host = inject(ElementRef<HTMLElement>);

  constructor() {
    effect(() => {
      this.activeId();
      queueMicrotask(() => this.scrollActiveIntoView());
    });
  }

  private scrollActiveIntoView(): void {
    const el = this.host.nativeElement.querySelector('.is-selected');
    (el as HTMLElement | null)?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  }
}
