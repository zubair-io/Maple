import { TestBed } from '@angular/core/testing';
import type { ComponentFixture } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';

import { MuiColorGradingPanelComponent } from './mui-color-grading-panel.component';

function render(): ComponentFixture<MuiColorGradingPanelComponent> {
  TestBed.configureTestingModule({ imports: [MuiColorGradingPanelComponent] });
  const fixture = TestBed.createComponent(MuiColorGradingPanelComponent);
  fixture.detectChanges();
  return fixture;
}

describe('MuiColorGradingPanelComponent', () => {
  it('renders three color wheels and five living sliders', () => {
    const fixture = render();
    expect(fixture.nativeElement.querySelectorAll('mui-color-wheel').length).toBe(3);
    expect(fixture.nativeElement.querySelectorAll('mui-living-slider').length).toBe(5);
  });

  it('setting the shadows wheel leaves midtones and highlights untouched', () => {
    const fixture = render();
    const c = fixture.componentInstance;
    c.shadows.set({ hue: 30, saturation: 60 });
    fixture.detectChanges();

    expect(c.shadows()).toEqual({ hue: 30, saturation: 60 });
    expect(c.midtones()).toEqual({ hue: 0, saturation: 0 });
    expect(c.highlights()).toEqual({ hue: 0, saturation: 0 });
  });

  it('setting one luminance slider leaves the other two untouched', () => {
    const fixture = render();
    const c = fixture.componentInstance;
    c.midtonesLuminance.set(25);
    fixture.detectChanges();

    expect(c.midtonesLuminance()).toBe(25);
    expect(c.shadowsLuminance()).toBe(0);
    expect(c.highlightsLuminance()).toBe(0);
  });

  it('blending and balance are independently settable', () => {
    const fixture = render();
    const c = fixture.componentInstance;
    c.blending.set(80);
    fixture.detectChanges();
    expect(c.blending()).toBe(80);
    expect(c.balance()).toBe(0);

    c.balance.set(-40);
    fixture.detectChanges();
    expect(c.balance()).toBe(-40);
    expect(c.blending()).toBe(80);
  });

  it('a wheel drag on the shadows wheel only updates the shadows model', () => {
    const fixture = render();
    const wheels: HTMLElement[] = fixture.nativeElement.querySelectorAll('.mui-color-wheel');
    const shadowsWheel = wheels[0];
    shadowsWheel.getBoundingClientRect = () =>
      ({ left: 0, top: 0, width: 72, height: 72, right: 72, bottom: 72 }) as DOMRect;
    shadowsWheel.setPointerCapture = () => {};
    shadowsWheel.dispatchEvent(
      new PointerEvent('pointerdown', {
        button: 0,
        clientX: 72,
        clientY: 36,
        pointerId: 1,
        bubbles: true,
      }),
    );
    fixture.detectChanges();

    const c = fixture.componentInstance;
    expect(c.shadows().hue).toBe(0);
    expect(c.shadows().saturation).toBeGreaterThan(0);
    expect(c.midtones()).toEqual({ hue: 0, saturation: 0 });
    expect(c.highlights()).toEqual({ hue: 0, saturation: 0 });
  });
});
