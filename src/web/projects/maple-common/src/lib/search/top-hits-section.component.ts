// TopHitsSectionComponent — up to 3 mixed-kind top hits for S7 (#622).
//
// Spec: docs/design/responsive-program/s7-search.md §2.
//
// Renders one row per `TopHit`: 36pt thumb (or kind-icon if absent),
// label with the query token wrapped in `--color-primary` 600-weight,
// optional sub-label, and a small kind tag (PLACE / ALBUM / KEYWORD /
// PERSON; photos don't get a tag — they're the implicit default).
//
// Substring highlighting is case-insensitive and matches the first
// occurrence per label. Multi-word queries highlight each token
// individually so "old paris" lights up "Old" and "Paris" but not
// "patios".

import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';
import { TopHit, TopHitKind } from './search-types';

interface LabelSegment {
  text: string;
  highlight: boolean;
}

@Component({
  selector: 'app-top-hits-section',
  standalone: true,
  templateUrl: './top-hits-section.component.html',
  styleUrl: './top-hits-section.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class TopHitsSectionComponent {
  readonly hits = input<readonly TopHit[]>([]);
  readonly query = input<string>('');
  /** Emitted when the user taps a hit row. Host routes to the editor (for
   * photos) or the relevant resource (for other kinds). */
  readonly hitTap = output<TopHit>();

  /** Pre-computed label segments per hit so the template stays declarative. */
  protected readonly hitRows = computed(() => {
    const q = this.query();
    return this.hits().map((hit) => ({ hit, segments: splitLabel(hit.label, q) }));
  });

  protected onTap(hit: TopHit): void {
    this.hitTap.emit(hit);
  }

  protected kindTag(kind: TopHitKind): string | null {
    // Photos don't get a tag — they're the default and the row visual is
    // already photo-shaped.
    switch (kind) {
      case 'place':
        return 'PLACE';
      case 'album':
        return 'ALBUM';
      case 'keyword':
        return 'KEYWORD';
      case 'person':
        return 'PERSON';
      case 'photo':
        return null;
    }
  }

  protected trackHit = (_: number, row: { hit: TopHit }) => row.hit.id;
}

/** Split a label into highlight + non-highlight segments. Pure for testing. */
export function splitLabel(label: string, query: string): LabelSegment[] {
  const q = query.trim();
  if (q.length === 0) return [{ text: label, highlight: false }];
  const tokens = q
    .split(/\s+/)
    .filter((t) => t.length > 0)
    .map((t) => t.toLowerCase());
  if (tokens.length === 0) return [{ text: label, highlight: false }];

  const segments: LabelSegment[] = [];
  const lower = label.toLowerCase();
  let cursor = 0;
  while (cursor < label.length) {
    // Find the nearest token match from `cursor`.
    let bestStart = -1;
    let bestEnd = -1;
    for (const tok of tokens) {
      const idx = lower.indexOf(tok, cursor);
      if (idx >= 0 && (bestStart < 0 || idx < bestStart)) {
        bestStart = idx;
        bestEnd = idx + tok.length;
      }
    }
    if (bestStart < 0) {
      segments.push({ text: label.slice(cursor), highlight: false });
      break;
    }
    if (bestStart > cursor) {
      segments.push({ text: label.slice(cursor, bestStart), highlight: false });
    }
    segments.push({ text: label.slice(bestStart, bestEnd), highlight: true });
    cursor = bestEnd;
  }
  return segments;
}
