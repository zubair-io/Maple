// RecentQueriesComponent — chip row of last-10 queries for S7 (#622).
//
// Spec: docs/design/responsive-program/s7-search.md §2.
//
// Persistence lives in the host (`SearchComponent`) so the component
// stays a dumb presenter — tests render it with a stub `recent` input
// without touching localStorage.

import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';

@Component({
  selector: 'app-recent-queries',
  standalone: true,
  templateUrl: './recent-queries.component.html',
  host: { class: 'block' },
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class RecentQueriesComponent {
  readonly recent = input<readonly string[]>([]);
  readonly recentTap = output<string>();

  protected onChipClick(q: string): void {
    this.recentTap.emit(q);
  }

  protected trackQuery = (_: number, q: string) => q;
}
