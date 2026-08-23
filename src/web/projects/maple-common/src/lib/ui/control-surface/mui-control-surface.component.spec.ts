import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import type { ComponentFixture } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';

import { MuiControlSurfaceComponent } from './mui-control-surface.component';
import type { MuiControlSurfaceSlider } from './mui-control-surface.component';
import type { MuiTab } from '../tabs/mui-tabs.component';

const TABS: readonly MuiTab[] = [
  { id: 'exposure', label: 'Exposure', icon: 'tool-exposure' },
  { id: 'color', label: 'Color', icon: 'tool-color-grade' },
];

const EXPOSURE_SLIDERS: readonly MuiControlSurfaceSlider[] = [
  { id: 'exposure', label: 'Exposure', value: 0, min: -100, max: 100, step: 1, unit: '' },
  { id: 'contrast', label: 'Contrast', value: 20, min: -100, max: 100, step: 1, unit: '' },
];

@Component({
  standalone: true,
  imports: [MuiControlSurfaceComponent],
  template: `
    <mui-control-surface
      [tabs]="tabs()"
      [(activeTab)]="activeTab"
      [sliders]="sliders()"
      (tabChanged)="tabChangedIds.push($event)"
      (sliderChanged)="sliderChanges.push($event)"
    />
  `,
})
class HostComponent {
  readonly tabs = signal<readonly MuiTab[]>(TABS);
  readonly activeTab = signal('exposure');
  readonly sliders = signal<readonly MuiControlSurfaceSlider[]>(EXPOSURE_SLIDERS);
  readonly tabChangedIds: string[] = [];
  readonly sliderChanges: { id: string; value: number }[] = [];
}

function render(): { fixture: ComponentFixture<HostComponent>; host: HostComponent } {
  TestBed.configureTestingModule({ imports: [HostComponent] });
  const fixture = TestBed.createComponent(HostComponent);
  fixture.detectChanges();
  return { fixture, host: fixture.componentInstance };
}

function pointerEvent(type: string, clientX: number, pointerId = 1): PointerEvent {
  return new PointerEvent(type, { button: 0, clientX, pointerId, bubbles: true });
}

describe('MuiControlSurfaceComponent', () => {
  it('selecting a different tab fires tabChanged with the right id', () => {
    const { fixture, host } = render();
    const tabButtons = fixture.nativeElement.querySelectorAll(
      '.tab',
    ) as NodeListOf<HTMLButtonElement>;
    expect(tabButtons.length).toBe(2);

    tabButtons[1].click();
    fixture.detectChanges();

    expect(host.tabChangedIds).toEqual(['color']);
    expect(host.activeTab()).toBe('color');
  });

  it('dragging a slider fires sliderChanged with the correct id and value', () => {
    const { fixture, host } = render();
    const track = fixture.nativeElement
      .querySelectorAll('mui-living-slider')[0]
      .querySelector('.track') as HTMLElement;
    track.getBoundingClientRect = () =>
      ({ left: 0, top: 0, width: 200, height: 6, right: 200, bottom: 6 }) as DOMRect;
    track.setPointerCapture = () => {};

    track.dispatchEvent(pointerEvent('pointerdown', 100));
    track.dispatchEvent(pointerEvent('pointermove', 150));
    fixture.detectChanges();

    expect(host.sliderChanges).toEqual([{ id: 'exposure', value: 50 }]);
  });

  it('shows a placeholder when the active tab has no sliders', () => {
    const { fixture, host } = render();
    host.sliders.set([]);
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('mui-empty-state')).not.toBeNull();
    expect(fixture.nativeElement.querySelector('mui-living-slider')).toBeNull();
  });
});
