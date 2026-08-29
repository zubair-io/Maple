// MuiTabs — Maple UI Molecules-L1 (unified-component-catalog.md §2.2). Tab
// row with a sliding selection indicator, built from Text + Icon. Roving
// tabindex per the WAI-ARIA tabs pattern: only the active tab is in the tab
// order, Left/Right/Home/End move both focus and selection.

import {
  AfterViewInit,
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  QueryList,
  ViewChildren,
  input,
  model,
  signal,
} from '@angular/core';
import { MuiIconComponent } from '../icon/mui-icon.component';
import type { MapleIconName } from '../icon/mui-icon.component';
import { MuiTextComponent } from '../text/mui-text.component';

export interface MuiTab {
  readonly id: string;
  readonly label: string;
  readonly icon?: MapleIconName;
}

@Component({
  selector: 'mui-tabs',
  standalone: true,
  imports: [MuiIconComponent, MuiTextComponent],
  templateUrl: './mui-tabs.component.html',
  host: { class: 'block' },
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MuiTabsComponent implements AfterViewInit {
  readonly tabs = input.required<readonly MuiTab[]>();
  readonly activeId = model<string>('');
  readonly ariaLabel = input<string>('Tabs');

  @ViewChildren('tabBtn') private tabButtons?: QueryList<ElementRef<HTMLElement>>;

  readonly indicatorLeft = signal(0);
  readonly indicatorWidth = signal(0);

  ngAfterViewInit(): void {
    queueMicrotask(() => this.measure());
  }

  select(id: string): void {
    if (id === this.activeId()) return;
    this.activeId.set(id);
    queueMicrotask(() => this.measure());
  }

  private measure(): void {
    const tabs = this.tabs();
    const index = tabs.findIndex((t) => t.id === this.activeId());
    const btn = index >= 0 ? this.tabButtons?.get(index)?.nativeElement : null;
    if (!btn) return;
    this.indicatorLeft.set(btn.offsetLeft);
    this.indicatorWidth.set(btn.offsetWidth);
  }

  onKeydown(event: KeyboardEvent, index: number): void {
    const tabs = this.tabs();
    if (tabs.length === 0) return;
    let nextIndex: number | null = null;
    if (event.key === 'ArrowRight') nextIndex = (index + 1) % tabs.length;
    else if (event.key === 'ArrowLeft') nextIndex = (index - 1 + tabs.length) % tabs.length;
    else if (event.key === 'Home') nextIndex = 0;
    else if (event.key === 'End') nextIndex = tabs.length - 1;
    else return;

    event.preventDefault();
    const next = tabs[nextIndex];
    this.select(next.id);
    queueMicrotask(() => this.tabButtons?.get(nextIndex!)?.nativeElement.focus());
  }
}
