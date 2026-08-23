import { TestBed } from '@angular/core/testing';
import type { ComponentFixture } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';

import { MuiHslPanelComponent } from './mui-hsl-panel.component';

function render(): ComponentFixture<MuiHslPanelComponent> {
  TestBed.configureTestingModule({ imports: [MuiHslPanelComponent] });
  const fixture = TestBed.createComponent(MuiHslPanelComponent);
  fixture.componentRef.setInput('values', {
    red: { hue: 10, saturation: 20, luminance: -5 },
    orange: { hue: -15, saturation: 40, luminance: 8 },
  });
  fixture.detectChanges();
  return fixture;
}

describe('MuiHslPanelComponent', () => {
  it('defaults to 8 real HSL bands when none are supplied', () => {
    const fixture = render();
    const chips: HTMLElement[] = fixture.nativeElement.querySelectorAll('.chip');
    expect(chips.length).toBe(8);
    expect(chips[0].textContent).toContain('Red');
    expect(chips[7].textContent).toContain('Magenta');
  });

  it('switching the active band changes the displayed slider values', () => {
    const fixture = render();
    const readouts = (): string[] =>
      Array.from(fixture.nativeElement.querySelectorAll('.readout')).map(
        (el) => (el as HTMLElement).textContent?.trim() ?? '',
      );
    expect(readouts()).toEqual(['+10', '+20', '-5']);

    fixture.componentRef.setInput('activeBandId', 'orange');
    fixture.detectChanges();
    expect(readouts()).toEqual(['-15', '+40', '+8']);
  });

  it('clicking a chip updates activeBandId', () => {
    const fixture = render();
    const chips: HTMLElement[] = fixture.nativeElement.querySelectorAll('.chip');
    chips[1].click();
    fixture.detectChanges();
    expect(fixture.componentInstance.activeBandId()).toBe('orange');
  });

  it('a slider change emits bandId, field, and value for the active band', () => {
    const fixture = render();
    const changes: { bandId: string; field: string; value: number }[] = [];
    fixture.componentInstance.valueChanged.subscribe((v) => changes.push(v));

    const tracks: HTMLElement[] = fixture.nativeElement.querySelectorAll('.track');
    // Order in the template is Hue, Saturation, Luminance.
    const saturationTrack = tracks[1];
    saturationTrack.getBoundingClientRect = () =>
      ({ left: 0, top: 0, width: 200, height: 6, right: 200, bottom: 6 }) as DOMRect;
    saturationTrack.setPointerCapture = () => {};
    saturationTrack.dispatchEvent(
      new PointerEvent('pointerdown', { button: 0, clientX: 100, pointerId: 1, bubbles: true }),
    );
    saturationTrack.dispatchEvent(
      new PointerEvent('pointermove', { button: 0, clientX: 150, pointerId: 1, bubbles: true }),
    );
    fixture.detectChanges();

    expect(changes.length).toBeGreaterThan(0);
    const last = changes[changes.length - 1];
    expect(last.bandId).toBe('red');
    expect(last.field).toBe('saturation');
  });
});
