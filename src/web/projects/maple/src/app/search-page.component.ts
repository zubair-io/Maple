// SearchPageComponent — `/search` route host for the unified search
// experience (#2865) in the Self-Hosted (maple) app.
//
// Wraps `<app-search>` from maple-common and wires it into the app
// router: photo taps push to `/view/<id>` (the fast Preview surface).
// Filters, the panel, and the `@` tag picker are internal to
// `<app-search>` — there is no separate advanced page anymore
// (`/search/advanced` is a redirect here since #2865).
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
import { SearchComponent, SearchResult, viewRouteCommands } from '@maple-common';

@Component({
  selector: 'maple-search-page',
  standalone: true,
  imports: [SearchComponent],
  template: `
    <app-search
      [initialQuery]="initialQuery"
      [autoFocus]="autoFocus"
      (photoTap)="onPhotoTap($event)"
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

  protected onQueryChange(q: string): void {
    const trimmed = q.trim();
    void this.router.navigate([], {
      relativeTo: this.route,
      queryParams: trimmed ? { q: trimmed } : {},
      replaceUrl: true,
    });
  }
}
