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
import { SearchComponent, SearchResult, SearchScope } from '@maple-common';

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
    // S5 (#625): route results to the responsive Editor shell at
    // /library/editor/:id. The Editor shell handles both plain asset ids
    // and fs: abs-path deep links.
    void this.router.navigate(['/library/editor', r.id]);
  }

  protected onSeeAll(_payload: { query: string; scope: SearchScope }): void {
    // Hosted has no rich filter page today; the button is a no-op so the
    // component output stays connected. Wiring lands when a filtered grid
    // experience exists. Payload typed to match `<app-search>` output so
    // template type-checking stays sound.
  }
}
