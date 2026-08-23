import { TestBed } from '@angular/core/testing';
import type { ComponentFixture } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';

import { MuiAdjustmentsPanelComponent } from './mui-adjustments-panel.component';
import type { MuiAdjustmentTab } from './mui-adjustments-panel.component';

const TABS: readonly MuiAdjustmentTab[] = [
  {
    id: 'light',
    label: 'Light',
    groups: [
      {
        id: 'tone',
        label: 'Tone',
        sliders: [
          { id: 'exposure', label: 'Exposure', min: -5, max: 5, step: 0.1 },
          { id: 'contrast', label: 'Contrast', min: -100, max: 100 },
        ],
      },
      {
        id: 'wb',
        label: 'White Balance',
        collapsedByDefault: true,
        sliders: [{ id: 'temperature', label: 'Temperature', min: 2000, max: 50000 }],
      },
    ],
  },
  {
    id: 'detail',
    label: 'Detail',
    groups: [
      {
        id: 'sharpening',
        label: 'Sharpening',
        sliders: [{ id: 'amount', label: 'Amount', min: 0, max: 150 }],
      },
    ],
  },
];

function render(): ComponentFixture<MuiAdjustmentsPanelComponent> {
  TestBed.configureTestingModule({ imports: [MuiAdjustmentsPanelComponent] });
  const fixture = TestBed.createComponent(MuiAdjustmentsPanelComponent);
  fixture.componentRef.setInput('tabs', TABS);
  fixture.componentRef.setInput('values', { exposure: 0.5, contrast: 10, amount: 40 });
  fixture.componentRef.setInput('activeTabId', 'light');
  fixture.detectChanges();
  return fixture;
}

describe('MuiAdjustmentsPanelComponent', () => {
  it('switching tabs changes the visible groups', () => {
    const fixture = render();
    let groupLabels: string[] = Array.from(
      fixture.nativeElement.querySelectorAll('.groups > mui-collapsible .header'),
    ).map((el) => (el as HTMLElement).textContent?.trim());
    expect(groupLabels).toEqual(['Tone', 'White Balance']);

    fixture.componentRef.setInput('activeTabId', 'detail');
    fixture.detectChanges();
    groupLabels = Array.from(
      fixture.nativeElement.querySelectorAll('.groups > mui-collapsible .header'),
    ).map((el) => (el as HTMLElement).textContent?.trim());
    expect(groupLabels).toEqual(['Sharpening']);
  });

  it('groups not marked collapsedByDefault start open, others start closed, and toggling flips them', () => {
    const fixture = render();
    const collapsibles: HTMLElement[] = Array.from(
      fixture.nativeElement.querySelectorAll('.groups > mui-collapsible'),
    );
    expect(collapsibles[0].querySelector('.header')?.getAttribute('aria-expanded')).toBe('true');
    expect(collapsibles[1].querySelector('.header')?.getAttribute('aria-expanded')).toBe('false');

    (collapsibles[1].querySelector('.header') as HTMLButtonElement).click();
    fixture.detectChanges();
    expect(collapsibles[1].querySelector('.header')?.getAttribute('aria-expanded')).toBe('true');
  });

  it('changing a slider value emits sliderId and value for that exact slider', () => {
    const fixture = render();
    const changes: { sliderId: string; value: number }[] = [];
    fixture.componentInstance.valueChanged.subscribe((v) => changes.push(v));

    const tracks: HTMLElement[] = fixture.nativeElement.querySelectorAll('.track');
    // First track under the open "Tone" group is Exposure.
    tracks[0].getBoundingClientRect = () =>
      ({ left: 0, top: 0, width: 200, height: 6, right: 200, bottom: 6 }) as DOMRect;
    tracks[0].setPointerCapture = () => {};
    tracks[0].dispatchEvent(
      new PointerEvent('pointerdown', { button: 0, clientX: 100, pointerId: 1, bubbles: true }),
    );
    tracks[0].dispatchEvent(
      new PointerEvent('pointermove', { button: 0, clientX: 120, pointerId: 1, bubbles: true }),
    );
    fixture.detectChanges();

    expect(changes.length).toBeGreaterThan(0);
    expect(changes[changes.length - 1].sliderId).toBe('exposure');
  });
});
