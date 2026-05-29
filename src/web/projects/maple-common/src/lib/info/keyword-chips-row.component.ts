// KeywordChipsRowComponent — S6 Info content section 4 (web).
//
// READ-ONLY in v0.1. `Asset.keywords` is already on the wire (see
// `lib/models/asset.ts`) but no LibraryStateService method exists to
// write through to the sidecar yet — `setKeywords` would need a new
// XMP `dc:subject` round-trip path (XMPParser + XMPSerializer + the
// debounced SidecarStore flush). Per spec §6 risk 3 default plan (a),
// chip-editing is a stub for v0.1. Follow-up ticket:
// "S6 keyword editing — XMP dc:subject round-trip + setKeywords".
//
// What renders today:
//   • Existing keywords from `asset.keywords` as 11pt rounded chips.
//   • A trailing dashed `+ Add` chip that opens an inline stub message.
//     Keeps the affordance visible for design review without mutating
//     state.

import { ChangeDetectionStrategy, Component, computed, input, signal } from '@angular/core';
import type { Asset } from '../models/asset';

@Component({
  selector: 'app-keyword-chips-row',
  standalone: true,
  templateUrl: './keyword-chips-row.component.html',
  styleUrl: './keyword-chips-row.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    class: 'block',
    'data-testid': 'info-keywords',
  },
})
export class KeywordChipsRowComponent {
  readonly asset = input<Asset | null>(null);

  protected readonly keywords = computed<readonly string[]>(() => this.asset()?.keywords ?? []);

  /** v0.1 stub flag — toggled by the `+ Add` chip to show the
   * "feature coming soon" inline hint. Replaced with a real text input
   * + EditSession.setKeywords mutator in the keyword-editing follow-up. */
  protected readonly showStubHint = signal(false);

  protected openAddDraft(): void {
    this.showStubHint.set(true);
  }

  protected dismissStubHint(): void {
    this.showStubHint.set(false);
  }

  protected removeKeyword(_keyword: string): void {
    // TODO(s6-keyword-editing): state.setKeywords(asset.id, keywords.filter(...))
  }
}
