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
import { SearchComponent, SearchResult, viewRouteCommands } from '@maple-common';

@Component({
  selector: 'maple-syrup-search-page',
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

  // Seed `<app-search>` from `/search?q=<query>` so the bar reflects the
  // deep-linked term — mirrors the Self-Hosted page.
  protected readonly initialQuery = this.route.snapshot.queryParamMap.get('q') ?? '';

  ngAfterViewInit(): void {
    if (this.autoFocus) this.searchEl?.focusSearchBar();
  }

  protected onPhotoTap(r: SearchResult): void {
    // Web Preview Surface Task 6c: route results to the fast Preview surface
    // at /view/:slug/**. Note: if/when Hosted search begins returning real
    // results, fs: id cold-load/hydration in Preview will need to land
    // first (#625).
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
