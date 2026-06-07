// MapleCollapsible — disclosure section with persistent collapse state.
// Matches _design-reference/lib/primitives.jsx MapleCollapsible exactly.

import { ChangeDetectionStrategy, Component, OnInit, computed, input, signal } from '@angular/core';
import { MapleIconComponent } from '../icons/maple-icon.component';
import { TypedStorage } from '../util/typed-storage';

@Component({
  selector: 'maple-collapsible',
  standalone: true,
  imports: [MapleIconComponent],
  styleUrl: './maple-collapsible.component.scss',
  host: { class: 'block' },
  templateUrl: './maple-collapsible.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MapleCollapsibleComponent implements OnInit {
  label = input.required<string>();
  defaultOpen = input<boolean>(true);
  storageKey = input<string | null>(null);
  padInner = input<boolean>(true);
  rightLabel = input<string | null>(null);

  open = signal<boolean>(true);

  ngOnInit(): void {
    const key = this.storageKey();
    if (key) {
      const stored = TypedStorage.getRaw(`cm.coll.${key}`);
      this.open.set(stored == null ? this.defaultOpen() : stored === '1');
    } else {
      this.open.set(this.defaultOpen());
    }
  }

  toggle(): void {
    const next = !this.open();
    this.open.set(next);
    const key = this.storageKey();
    if (key) {
      TypedStorage.setRaw(`cm.coll.${key}`, next ? '1' : '0');
    }
  }
}
