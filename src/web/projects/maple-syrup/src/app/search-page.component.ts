// SearchPageComponent — `/search` route host for the responsive-program
// S7 (#622) search experience in the Hosted (maple-syrup) app.
//
// Mirror of the Self-Hosted page. Hosted doesn't have a server-backed
// search index, so the underlying `SearchService` returns an empty
// response — the UI still renders, recents still persist, and the
// component is ready to wire up to a Hosted search source the day one
// exists.

import {
  AfterViewInit,
  ChangeDetectionStrategy,
  Component,
  ViewChild,
  inject,
} from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { SearchComponent, SearchResult } from '@maple-common';

@Component({
  selector: 'maple-syrup-search-page',
  standalone: true,
  imports: [SearchComponent],
  template: `
    <app-search
      [autoFocus]="autoFocus"
      (photoTap)="onPhotoTap($event)"
      (seeAll)="onSeeAll($event)"
    />
  `,
  styles: [
    `
      :host {
        display: block;
        height: 100%;
      }
    `,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SearchPageComponent implements AfterViewInit {
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);

  @ViewChild(SearchComponent) private searchEl?: SearchComponent;

  protected readonly autoFocus = this.route.snapshot.queryParamMap.get('autoFocus') === '1';

  ngAfterViewInit(): void {
    if (this.autoFocus) this.searchEl?.focusSearchBar();
  }

  protected onPhotoTap(r: SearchResult): void {
    // Hosted Editor shell at `/edit/:id` — same contract as Self-Hosted.
    void this.router.navigate(['/edit', r.id]);
  }

  protected onSeeAll(_payload: { query: string }): void {
    // Hosted has no rich filter page today; the button is a no-op so the
    // component output stays connected. Wiring lands when a filtered grid
    // experience exists.
  }
}
