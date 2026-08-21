// GeneratedSearchCollectionsComponent — the list of collections a run
// produced.
//
// The other half of the Generated Searches panel. These are LLM-invented and
// change daily, so reading them is part of using the product — each row
// deep-links into /search with its own stored filters, which is how an
// operator checks whether a theme actually found the photos it claims.
//
// Presentational: the parent owns the fetch and hands the results down.

import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import type { GeneratedSearchCard } from '@maple-common';

@Component({
  selector: 'maple-generated-search-collections',
  standalone: true,
  templateUrl: './generated-search-collections.component.html',
  styleUrl: './generated-search-collections.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class GeneratedSearchCollectionsComponent {
  readonly cards = input.required<readonly GeneratedSearchCard[]>();
  /** What the run was asked for, so a short day can be explained. */
  readonly requested = input<number | null>(null);

  /** True when the run kept fewer than it was asked for. Proposals matching
   * too few photos are discarded rather than padded, so a short day is an
   * honest outcome — but the operator should see it stated rather than
   * wonder why the widget has two cards. */
  protected readonly producedFewer = computed(() => {
    const requested = this.requested();
    const count = this.cards().length;
    return requested !== null && count > 0 && count < requested;
  });

  /** Human-readable summary of the query a collection was built from.
   *
   * NOT a link to /search. That route (`SearchPageComponent`) reads only `q`
   * and `autoFocus` from the URL — the filter-hydrating advanced page was
   * removed from main — so a deep-link would run a DIFFERENT search and show
   * photos the collection does not contain. Showing the query as text is
   * honest about what the collection asked for; wiring a real link needs
   * /search to hydrate filters first (tracked separately).
   */
  protected queryLine(card: GeneratedSearchCard): string {
    const parts = Object.entries(card.query)
      .filter(([, value]) => value !== null && value !== '')
      .map(([key, value]) => `${key}: ${value}`);
    return parts.join(' · ');
  }
}
