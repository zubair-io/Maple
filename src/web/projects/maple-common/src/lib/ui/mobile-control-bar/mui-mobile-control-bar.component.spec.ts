import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import type { ComponentFixture } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';

import { MuiMobileControlBarComponent } from './mui-mobile-control-bar.component';
import type { MuiMobileControlBarTool } from './mui-mobile-control-bar.component';
import type { MuiControlSurfaceSlider } from '../control-surface/mui-control-surface.component';
import type { MuiTab } from '../tabs/mui-tabs.component';

const TOOLS: readonly MuiMobileControlBarTool[] = [
  { id: 'crop', icon: 'tool-crop', label: 'Crop' },
  { id: 'exposure', icon: 'tool-exposure', label: 'Exposure' },
];

const TABS: readonly MuiTab[] = [{ id: 'exposure', label: 'Exposure' }];

const SLIDERS: readonly MuiControlSurfaceSlider[] = [
  { id: 'exposure', label: 'Exposure', value: 0, min: -100, max: 100, step: 1, unit: '' },
];

@Component({
  standalone: true,
  imports: [MuiMobileControlBarComponent],
  template: `
    <mui-mobile-control-bar
      [tools]="tools()"
      [(toolId)]="toolId"
      [tabs]="tabs()"
      [(activeTab)]="activeTab"
      [sliders]="sliders()"
      (toolSelected)="toolSelectedIds.push($event)"
      (sliderChanged)="sliderChanges.push($event)"
    />
  `,
})
class HostComponent {
  readonly tools = signal<readonly MuiMobileControlBarTool[]>(TOOLS);
  readonly toolId = signal('exposure');
  readonly tabs = signal<readonly MuiTab[]>(TABS);
  readonly activeTab = signal('exposure');
  readonly sliders = signal<readonly MuiControlSurfaceSlider[]>(SLIDERS);
  readonly toolSelectedIds: string[] = [];
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

describe('MuiMobileControlBarComponent', () => {
  it('clicking a tool button fires toolSelected and marks it selected', () => {
    const { fixture, host } = render();
    const buttons = fixture.nativeElement.querySelectorAll(
      '.mui-action-button',
    ) as NodeListOf<HTMLButtonElement>;
    expect(buttons.length).toBe(2);

    buttons[0].click();
    fixture.detectChanges();

    expect(host.toolSelectedIds).toEqual(['crop']);
    expect(buttons[0].classList.contains('selected')).toBe(true);
    expect(buttons[1].classList.contains('selected')).toBe(false);
  });

  it('bubbles a sliderChanged from the inner control surface unchanged', () => {
    const { fixture, host } = render();
    const track = fixture.nativeElement
      .querySelector('mui-living-slider')
      .querySelector('.track') as HTMLElement;
    track.getBoundingClientRect = () =>
      ({ left: 0, top: 0, width: 200, height: 6, right: 200, bottom: 6 }) as DOMRect;
    track.setPointerCapture = () => {};

    track.dispatchEvent(pointerEvent('pointerdown', 100));
    track.dispatchEvent(pointerEvent('pointermove', 150));
    fixture.detectChanges();

    expect(host.sliderChanges).toEqual([{ id: 'exposure', value: 50 }]);
  });
});
