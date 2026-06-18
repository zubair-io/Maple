// SearchPageComponent — `/search` route host for the responsive-program
// S7 (#622) search experience in the Self-Hosted (maple) app.
//
// Wraps `<app-search>` from maple-common and wires it into the app
// router: photo taps push to `/edit/<id>` (the Editor shell), and the
// "See all" button leaves the user on the same page (no filtered grid
// view yet — that lands as part of S7 follow-up or as a redirect into
// the existing rich filter page at `/search/advanced`).
//
// On mount the component checks `?autoFocus=1` — set by S1b drawer's
// search pill tap — and focuses the search bar. The S1b
// `mapleFocusSearch` notification (Apple side) maps to this query param
// on web.

import {
  AfterViewInit,
  ChangeDetectionStrategy,
  Component,
  ViewChild,
  inject,
} from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { SearchComponent, SearchResult, SearchScope, editRouteCommands } from '@maple-common';

@Component({
  selector: 'maple-search-page',
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
    // Belt-and-suspenders: `autoFocus` input drives a queueMicrotask focus,
    // but if a host re-uses the route via navigation reuse the input may
    // not re-fire — call the imperative hook too.
    if (this.autoFocus) this.searchEl?.focusSearchBar();
  }

  protected onPhotoTap(r: SearchResult): void {
    // Split the slug:relPath id into /edit/:slug/** segments (see
    // editRouteCommands); the combined form bounces back to Browse.
    void this.router.navigate(editRouteCommands(r.id));
  }

  protected onSeeAll(payload: { query: string; scope: SearchScope }): void {
    // Until a filtered grid lands, route "See all" into the rich filter
    // page so the user can drill further. The rich page sits at
    // `/search/advanced` (alias) and accepts `?q=` on entry. The scope
    // is preserved in the payload type so a future filtered-grid landing
    // can read it without changing the `<app-search>` contract.
    void this.router.navigate(['/search/advanced'], {
      queryParams: payload.query ? { q: payload.query } : {},
    });
  }
}
