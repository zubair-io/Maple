// MapleCollapsible — disclosure section with persistent collapse state.
// Matches _design-reference/lib/primitives.jsx MapleCollapsible exactly.

import { ChangeDetectionStrategy, Component, OnInit, computed, input, signal } from '@angular/core';
import { MapleIconComponent } from '../icons/maple-icon.component';

@Component({
  selector: 'maple-collapsible',
  standalone: true,
  imports: [MapleIconComponent],
  styles: [
    `
      :host {
        border-bottom: 0.5px solid var(--color-border);
      }
    `,
  ],
  host: { class: 'block' },
  template: `
    <div
      class="flex items-center gap-1.5 pl-2.5 pr-3.5 py-[9px] cursor-pointer select-none hover:bg-bg-hover"
      (click)="toggle()"
    >
      <div
        class="w-3 flex items-center justify-center text-text-muted transition-transform duration-150 ease-default"
        [class.rotate-90]="open()"
      >
        <maple-icon
          name="chevron-right"
          [size]="10"
          color="var(--color-text-muted)"
          [strokeWidth]="2"
        />
      </div>
      <span class="flex-1 text-[10px] font-semibold uppercase tracking-[0.08em] text-text-muted">{{ label() }}</span>
      @if (rightLabel()) {
        <span class="font-mono text-[10px] text-text-muted">
          {{ rightLabel() }}
        </span>
      }
    </div>
    @if (open()) {
      <div [class.pt-0.5]="padInner()" [class.pb-2.5]="padInner()">
        <ng-content />
      </div>
    }
  `,
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
      try {
        const stored = localStorage.getItem(`cm.coll.${key}`);
        this.open.set(stored == null ? this.defaultOpen() : stored === '1');
      } catch {
        this.open.set(this.defaultOpen());
      }
    } else {
      this.open.set(this.defaultOpen());
    }
  }

  toggle(): void {
    const next = !this.open();
    this.open.set(next);
    const key = this.storageKey();
    if (key) {
      try {
        localStorage.setItem(`cm.coll.${key}`, next ? '1' : '0');
      } catch {
        /* noop */
      }
    }
  }
}
