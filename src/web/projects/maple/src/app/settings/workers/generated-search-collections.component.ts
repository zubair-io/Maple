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
import { RouterLink } from '@angular/router';
import type { GeneratedSearchCard } from '@maple-common';

@Component({
  selector: 'maple-generated-search-collections',
  standalone: true,
  imports: [RouterLink],
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

  /** Human-readable summary of the query a collection was built from. */
  protected queryLine(card: GeneratedSearchCard): string {
    const parts = Object.entries(card.query)
      .filter(([, value]) => value !== '')
      .map(([key, value]) => `${key}: ${value}`);
    return parts.join(' · ');
  }

  protected readonly searchLink = ['/search'];

  /** Deep-link params for a collection. The /search page now hydrates every
   * one of these into visible, removable filter chips (placeQuery seeds the
   * search box), so the link shows what the collection shows — the earlier
   * version of this link was removed precisely because the page dropped the
   * filters and ran a different search. */
  protected searchParams(card: GeneratedSearchCard): Record<string, string> {
    // `card.query` is already Record<string, string> — the worker's
    // validator stores only set fields — so this only drops empties.
    const params: Record<string, string> = {};
    for (const [key, value] of Object.entries(card.query)) {
      if (value !== '') params[key] = value;
    }
    return params;
  }
}
