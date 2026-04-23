// MapleCollapsible — disclosure section with persistent collapse state.
// Matches _design-reference/lib/primitives.jsx MapleCollapsible exactly.

import { Component, OnInit, computed, input, signal } from '@angular/core';
import { MapleIconComponent } from '../icons/maple-icon.component';

@Component({
  selector: 'maple-collapsible',
  standalone: true,
  imports: [MapleIconComponent],
  styles: [`
    :host { display: block; border-bottom: 0.5px solid var(--maple-border); }

    .header {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 9px 14px 9px 10px;
      cursor: pointer;
      user-select: none;
    }
    .header:hover { background: var(--maple-bg-hover); }

    .chevron {
      width: 12px;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: transform 140ms ease;
      color: var(--maple-text-muted);
    }
    .chevron.open { transform: rotate(90deg); }

    .section-label {
      flex: 1;
      font-family: var(--maple-font);
      font-size: 10px;
      font-weight: 600;
      color: var(--maple-text-muted);
      letter-spacing: 0.08em;
      text-transform: uppercase;
    }

    .body { }
    .body.pad { padding: 2px 0 10px; }
  `],
  template: `
    <div class="header" (click)="toggle()">
      <div class="chevron" [class.open]="open()">
        <maple-icon name="chevron-right" [size]="10" color="var(--maple-text-muted)" [strokeWidth]="2"/>
      </div>
      <span class="section-label">{{ label() }}</span>
      @if (rightLabel()) {
        <span style="font-family:var(--maple-font-mono);font-size:10px;color:var(--maple-text-muted)">
          {{ rightLabel() }}
        </span>
      }
    </div>
    @if (open()) {
      <div class="body" [class.pad]="padInner()">
        <ng-content/>
      </div>
    }
  `,
})
export class MapleCollapsibleComponent implements OnInit {
  label       = input.required<string>();
  defaultOpen = input<boolean>(true);
  storageKey  = input<string | null>(null);
  padInner    = input<boolean>(true);
  rightLabel  = input<string | null>(null);

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
      try { localStorage.setItem(`cm.coll.${key}`, next ? '1' : '0'); } catch { /* noop */ }
    }
  }
}
