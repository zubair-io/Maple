// SearchPageComponent — `/search` route host for the responsive-program
// S7 (#622) search experience in the Self-Hosted (maple) app.
//
// Wraps `<app-search>` from maple-common and wires it into the app
// router: photo taps push to `/view/<id>` (the fast Preview surface,
// Web Preview Surface Task 6c), and the "See all" button leaves the user
// on the same page (no filtered grid view yet — that lands as part of S7
// follow-up or as a redirect into the existing rich filter page at
// `/search/advanced`).
//
// On mount the component reads two query params off the route:
//   - `?q=<query>` — the search term the browse-shell toolbar and the S1b
//     drawer search pill deep-link with. It seeds `<app-search>` so the bar
//     shows the term and the (content) search fires on landing.
//   - `?autoFocus=1` — set by the S1b drawer's search pill tap — focuses the
//     search bar. The S1b `mapleFocusSearch` notification (Apple side) maps to
//     this query param on web.

import {
  AfterViewInit,
  ChangeDetectionStrategy,
  Component,
  ViewChild,
  inject,
} from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { SearchComponent, SearchResult, SearchScope, viewRouteCommands } from '@maple-common';

@Component({
  selector: 'maple-search-page',
  standalone: true,
  imports: [SearchComponent],
  template: `
    <app-search
      [initialQuery]="initialQuery"
      [autoFocus]="autoFocus"
      [showFilters]="true"
      (photoTap)="onPhotoTap($event)"
      (filters)="onFilters($event)"
      (queryChange)="onQueryChange($event)"
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

  // The toolbar search + drawer search pill deep-link to `/search?q=<query>`.
  // Seed `<app-search>` with it so the bar shows the term and the search fires
  // on landing; without this the query is dropped at the route boundary.
  protected readonly initialQuery = this.route.snapshot.queryParamMap.get('q') ?? '';

  ngAfterViewInit(): void {
    // Belt-and-suspenders: `autoFocus` input drives a queueMicrotask focus,
    // but if a host re-uses the route via navigation reuse the input may
    // not re-fire — call the imperative hook too.
    if (this.autoFocus) this.searchEl?.focusSearchBar();
  }

  protected onPhotoTap(r: SearchResult): void {
    // Web Preview Surface Task 6c: route results to the fast Preview surface
    // at /view/:slug/**. Self-Hosted search returns `fs:<absPath>` ids;
    // viewRouteCommands() passes those through as a single :slug segment and
    // PreviewShellComponent resolves them via the self-hosted-synth path.
    void this.router.navigate(viewRouteCommands(r.id));
  }

  protected onFilters(payload: { query: string; scope: SearchScope }): void {
    // The Filters button routes into the rich filter page so the user can
    // drill further (ISO/camera/lens ranges, vision facets). The rich page
    // sits at `/search/advanced` and accepts `?q=` on entry; the current
    // query is forwarded so the advanced box lands prefilled. Scope is in the
    // payload type for a future filtered-grid landing without changing the
    // `<app-search>` contract.
    void this.router.navigate(['/search/advanced'], {
      queryParams: payload.query ? { q: payload.query } : {},
    });
  }

  protected onQueryChange(q: string): void {
    void this.router.navigate([], {
      relativeTo: this.route,
      queryParams: q ? { q } : {},
      replaceUrl: true,
    });
  }
}
