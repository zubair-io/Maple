import { TestBed } from '@angular/core/testing';
import type { ComponentFixture } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';

import { MuiTabsComponent } from './mui-tabs.component';

const TABS = [
  { id: 'light', label: 'Light' },
  { id: 'color', label: 'Color' },
  { id: 'detail', label: 'Detail' },
];

function render(): ComponentFixture<MuiTabsComponent> {
  TestBed.configureTestingModule({ imports: [MuiTabsComponent] });
  const fixture = TestBed.createComponent(MuiTabsComponent);
  fixture.componentRef.setInput('tabs', TABS);
  fixture.componentRef.setInput('activeId', 'light');
  fixture.detectChanges();
  return fixture;
}

function tabButtons(fixture: ComponentFixture<MuiTabsComponent>): HTMLButtonElement[] {
  return Array.from(fixture.nativeElement.querySelectorAll('.tab'));
}

describe('MuiTabsComponent', () => {
  it('marks the active tab aria-selected and puts only it in the tab order', async () => {
    const fixture = render();
    await Promise.resolve();
    const [light, color, detail] = tabButtons(fixture);
    expect(light.getAttribute('aria-selected')).toBe('true');
    expect(light.getAttribute('tabindex')).toBe('0');
    expect(color.getAttribute('tabindex')).toBe('-1');
    expect(detail.getAttribute('tabindex')).toBe('-1');
  });

  it('clicking a tab selects it', async () => {
    const fixture = render();
    tabButtons(fixture)[1].click();
    fixture.detectChanges();
    await Promise.resolve();
    expect(fixture.componentInstance.activeId()).toBe('color');
  });

  it('ArrowRight/ArrowLeft move selection and wrap around', async () => {
    const fixture = render();
    const [light] = tabButtons(fixture);
    light.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
    fixture.detectChanges();
    await Promise.resolve();
    expect(fixture.componentInstance.activeId()).toBe('detail'); // wraps to the last tab

    tabButtons(fixture)[2].dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }),
    );
    fixture.detectChanges();
    await Promise.resolve();
    expect(fixture.componentInstance.activeId()).toBe('light'); // wraps back to the first
  });

  it('Home/End jump to the first/last tab', async () => {
    const fixture = render();
    const [light] = tabButtons(fixture);
    light.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }));
    fixture.detectChanges();
    await Promise.resolve();
    expect(fixture.componentInstance.activeId()).toBe('detail');

    tabButtons(fixture)[2].dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Home', bubbles: true }),
    );
    fixture.detectChanges();
    await Promise.resolve();
    expect(fixture.componentInstance.activeId()).toBe('light');
  });
});
