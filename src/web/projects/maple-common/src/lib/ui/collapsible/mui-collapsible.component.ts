// MuiCollapsible — the Maple UI design-system Collapsible molecule
// (unified-component-catalog.md §2.5; Built from: Icon, Text). A disclosure
// header + animated content region. Built fresh, tokenized and OnPush,
// rather than reusing the older `lib/collapsible/MapleCollapsibleComponent`
// app component per the wave-3 brief.
//
// `storageKey`/`defaultOpen`/`padInner` (MW2, #3029): every real consumer
// of the legacy `MapleCollapsibleComponent` — the info-panel row family and
// the develop/editor section headers — passes `storageKey` to persist its
// collapsed state across sessions the way a native app's disclosure
// triangles do, and about half of them override the closed-by-default
// state. Self-initialization only runs when `storageKey` is set: the
// existing externally-controlled `[(open)]` usage (no `storageKey`) is
// left untouched, so a bare two-way-bound instance still starts from
// whatever the caller's own signal holds.

import { ChangeDetectionStrategy, Component, OnInit, input, model } from '@angular/core';
import { MuiIconComponent } from '../icon/mui-icon.component';
import { MuiTextComponent } from '../text/mui-text.component';
import { TypedStorage } from '../../util/typed-storage';

@Component({
  selector: 'mui-collapsible',
  standalone: true,
  imports: [MuiIconComponent, MuiTextComponent],
  templateUrl: './mui-collapsible.component.html',
  styleUrl: './mui-collapsible.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MuiCollapsibleComponent implements OnInit {
  readonly label = input.required<string>();
  readonly open = model<boolean>(false);
  /** Persists open/closed to `localStorage` under `cm.coll.<storageKey>` and
   * seeds the initial state from it. `null` (default) opts out of
   * persistence entirely — `open` is then purely caller-controlled. */
  readonly storageKey = input<string | null>(null);
  /** Initial state when `storageKey` has no stored value yet (or is unset
   * but a consumer still wants an initializer — always paired with
   * `storageKey` today). */
  readonly defaultOpen = input<boolean>(true);
  /** Adds the standard vertical inset around projected content. Off for
   * hosts that already pad their own content (e.g. the develop/editor
   * section bodies). */
  readonly padInner = input<boolean>(true);

  ngOnInit(): void {
    const key = this.storageKey();
    if (!key) return;
    const stored = TypedStorage.getRaw(`cm.coll.${key}`);
    this.open.set(stored == null ? this.defaultOpen() : stored === '1');
  }

  toggle(): void {
    const next = !this.open();
    this.open.set(next);
    const key = this.storageKey();
    if (key) TypedStorage.setRaw(`cm.coll.${key}`, next ? '1' : '0');
  }
}
