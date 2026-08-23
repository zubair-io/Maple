import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import type { ComponentFixture } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';

import { MuiTabShellComponent } from './mui-tab-shell.component';
import type { MuiTab } from '../tabs/mui-tabs.component';

const TABS: readonly MuiTab[] = [
  { id: 'timeline', label: 'Timeline' },
  { id: 'map', label: 'Map' },
];

@Component({
  standalone: true,
  imports: [MuiTabShellComponent],
  template: `
    <mui-tab-shell [tabs]="tabs" [(activeId)]="activeId" [placement]="placement()">
      <div class="content-probe">Content</div>
    </mui-tab-shell>
  `,
})
class HostComponent {
  readonly tabs = TABS;
  activeId = 'timeline';
  readonly placement = signal<'auto' | 'top' | 'bottom'>('auto');
}

function render(): { fixture: ComponentFixture<HostComponent>; host: HostComponent } {
  TestBed.configureTestingModule({ imports: [HostComponent] });
  const fixture = TestBed.createComponent(HostComponent);
  fixture.detectChanges();
  return { fixture, host: fixture.componentInstance };
}

describe('MuiTabShellComponent', () => {
  it('renders the tab bar (mui-tabs) and projects content', () => {
    const { fixture } = render();
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('.tab-bar mui-tabs')).not.toBeNull();
    expect(el.querySelector('.content .content-probe')).not.toBeNull();
  });

  it('two-way binds activeId through to mui-tabs', () => {
    const { fixture, host } = render();
    const tabButtons = fixture.nativeElement.querySelectorAll('mui-tabs button');
    (tabButtons[1] as HTMLButtonElement).click();
    fixture.detectChanges();
    expect(host.activeId).toBe('map');
  });

  it('defaults to placement-auto (container-query breakpoint drives bottom placement)', () => {
    const { fixture } = render();
    expect(fixture.nativeElement.querySelector('.mui-tab-shell.placement-auto')).not.toBeNull();
  });

  it('forces bottom placement regardless of width when placement="bottom"', () => {
    const { fixture, host } = render();
    host.placement.set('bottom');
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.mui-tab-shell.placement-bottom')).not.toBeNull();
  });
});
