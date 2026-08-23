import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import type { ComponentFixture } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';

import { MuiInspectorPanelComponent } from './mui-inspector-panel.component';

@Component({
  selector: 'mui-inspector-panel-host',
  standalone: true,
  imports: [MuiInspectorPanelComponent],
  template: `
    <mui-inspector-panel
      title="Photo details"
      [tabs]="[
        { id: 'info', label: 'Info' },
        { id: 'ai', label: 'AI' },
      ]"
      [showMore]="true"
      (back)="backCount = backCount + 1"
      (more)="moreCount = moreCount + 1"
    >
      <div class="projected-body">projected content</div>
    </mui-inspector-panel>
  `,
})
class HostComponent {
  backCount = 0;
  moreCount = 0;
}

function render(): ComponentFixture<HostComponent> {
  TestBed.configureTestingModule({ imports: [HostComponent] });
  const fixture = TestBed.createComponent(HostComponent);
  fixture.detectChanges();
  return fixture;
}

function panelInstance(fixture: ComponentFixture<HostComponent>): MuiInspectorPanelComponent {
  return fixture.debugElement.query(
    (n) => n.componentInstance instanceof MuiInspectorPanelComponent,
  ).componentInstance as MuiInspectorPanelComponent;
}

describe('MuiInspectorPanelComponent', () => {
  it('renders the page header title and tab labels', () => {
    const fixture = render();
    expect(fixture.nativeElement.querySelector('.title').textContent).toContain('Photo details');
    const tabs = fixture.nativeElement.querySelectorAll('.tab');
    expect(tabs.length).toBe(2);
    expect(tabs[0].textContent).toContain('Info');
    expect(tabs[1].textContent).toContain('AI');
  });

  it('renders projected body content', () => {
    const fixture = render();
    expect(fixture.nativeElement.querySelector('.projected-body').textContent).toContain(
      'projected content',
    );
  });

  it('switches the active tab on click', () => {
    const fixture = render();
    const panel = panelInstance(fixture);
    expect(panel.activeTabId()).toBe('');

    const tabs: HTMLElement[] = fixture.nativeElement.querySelectorAll('.tab');
    tabs[1].click();
    fixture.detectChanges();
    expect(panel.activeTabId()).toBe('ai');
  });

  it('emits back and more from the page header actions', () => {
    const fixture = render();
    const buttons: HTMLElement[] = fixture.nativeElement.querySelectorAll(
      '.mui-page-header mui-button button',
    );
    expect(buttons.length).toBe(2);
    buttons[0].click();
    buttons[1].click();
    fixture.detectChanges();
    expect(fixture.componentInstance.backCount).toBe(1);
    expect(fixture.componentInstance.moreCount).toBe(1);
  });
});
