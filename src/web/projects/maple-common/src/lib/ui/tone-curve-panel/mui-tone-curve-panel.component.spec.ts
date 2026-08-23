import { TestBed } from '@angular/core/testing';
import type { ComponentFixture } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { describe, expect, it } from 'vitest';

import { MuiToneCurvePanelComponent } from './mui-tone-curve-panel.component';
import { MuiCurvePlotComponent } from '../curve-plot/mui-curve-plot.component';
import { MuiLivingSliderComponent } from '../living-slider/mui-living-slider.component';

const POINTS = {
  rgb: [
    { x: 0, y: 0 },
    { x: 1, y: 1 },
  ],
  red: [
    { x: 0, y: 0.2 },
    { x: 1, y: 0.9 },
  ],
};

function render(): ComponentFixture<MuiToneCurvePanelComponent> {
  TestBed.configureTestingModule({ imports: [MuiToneCurvePanelComponent] });
  const fixture = TestBed.createComponent(MuiToneCurvePanelComponent);
  fixture.componentRef.setInput('points', POINTS);
  fixture.detectChanges();
  return fixture;
}

describe('MuiToneCurvePanelComponent', () => {
  it('defaults to the rgb/red/green/blue channel set and the rgb channel active', () => {
    const fixture = render();
    const tabButtons = fixture.nativeElement.querySelectorAll('mui-tabs .tab');
    expect(tabButtons.length).toBe(4);
    expect(fixture.componentInstance.activeChannelId()).toBe('rgb');
    expect(fixture.componentInstance.activePoints()).toEqual(POINTS.rgb);
  });

  it('switching channel tabs changes the displayed curve points', () => {
    const fixture = render();
    const tabButtons = fixture.nativeElement.querySelectorAll('mui-tabs .tab');
    (tabButtons[1] as HTMLButtonElement).click();
    fixture.detectChanges();

    expect(fixture.componentInstance.activeChannelId()).toBe('red');
    expect(fixture.componentInstance.activePoints()).toEqual(POINTS.red);

    const plot = fixture.debugElement.query(By.directive(MuiCurvePlotComponent))
      .componentInstance as MuiCurvePlotComponent;
    expect(plot.points()).toEqual(POINTS.red);
  });

  it('a curve change on the active channel emits pointsChanged with the right channel id', () => {
    const fixture = render();
    const tabButtons = fixture.nativeElement.querySelectorAll('mui-tabs .tab');
    (tabButtons[1] as HTMLButtonElement).click();
    fixture.detectChanges();

    const emitted: { channelId: string; points: readonly { x: number; y: number }[] }[] = [];
    fixture.componentInstance.pointsChanged.subscribe((event) => emitted.push(event));

    const plot = fixture.debugElement.query(By.directive(MuiCurvePlotComponent))
      .componentInstance as MuiCurvePlotComponent;
    const nextPoints = [
      { x: 0, y: 0.1 },
      { x: 1, y: 0.95 },
    ];
    plot.points.set(nextPoints);

    expect(emitted).toEqual([{ channelId: 'red', points: nextPoints }]);
  });

  it('falls back to a straight-line default curve for a channel missing from points', () => {
    TestBed.configureTestingModule({ imports: [MuiToneCurvePanelComponent] });
    const fixture = TestBed.createComponent(MuiToneCurvePanelComponent);
    fixture.componentRef.setInput('points', { rgb: POINTS.rgb });
    fixture.componentRef.setInput('activeChannelId', 'blue');
    fixture.detectChanges();

    expect(fixture.componentInstance.activePoints()).toEqual([
      { x: 0, y: 0 },
      { x: 0.5, y: 0.5 },
      { x: 1, y: 1 },
    ]);
  });

  it('the four parametric sliders two-way bind highlights/lights/darks/shadows', () => {
    const fixture = render();
    fixture.componentRef.setInput('highlights', 25);
    fixture.detectChanges();

    const sliders = fixture.debugElement.queryAll(By.directive(MuiLivingSliderComponent));
    expect(sliders.length).toBe(4);
    const highlightsSlider = sliders[0].componentInstance as MuiLivingSliderComponent;
    expect(highlightsSlider.value()).toBe(25);
    expect(highlightsSlider.min()).toBe(-100);
    expect(highlightsSlider.max()).toBe(100);
    expect(highlightsSlider.bipolar()).toBe(true);

    const darksSlider = sliders[2].componentInstance as MuiLivingSliderComponent;
    darksSlider.value.set(-40);
    expect(fixture.componentInstance.darks()).toBe(-40);
  });
});
