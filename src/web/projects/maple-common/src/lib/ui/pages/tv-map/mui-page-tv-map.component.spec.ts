import { TestBed } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';

import { MuiPageTvMapComponent } from './mui-page-tv-map.component';

describe('MuiPageTvMapComponent', () => {
  it('renders the Map Surface with heatmap off on the Map tab', () => {
    const fixture = TestBed.createComponent(MuiPageTvMapComponent);
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('mui-map-surface')).toBeTruthy();
    expect(fixture.componentInstance.heatmapVisible()).toBe(false);
  });

  it('turns on the heatmap when the Density tab is selected', () => {
    const fixture = TestBed.createComponent(MuiPageTvMapComponent);
    fixture.detectChanges();

    fixture.componentInstance.activeTabId.set('density');
    fixture.detectChanges();

    expect(fixture.componentInstance.heatmapVisible()).toBe(true);
  });

  it('switches the active tab back to Map when the heatmap is toggled off directly', () => {
    const fixture = TestBed.createComponent(MuiPageTvMapComponent);
    fixture.componentInstance.activeTabId.set('density');
    fixture.detectChanges();

    fixture.componentInstance.onHeatmapToggled(false);
    fixture.detectChanges();

    expect(fixture.componentInstance.activeTabId()).toBe('map');
  });

  it('updates the caption when a pin is selected', () => {
    const fixture = TestBed.createComponent(MuiPageTvMapComponent);
    fixture.detectChanges();

    fixture.componentInstance.onAnnotationSelected('m3');
    fixture.detectChanges();

    expect(fixture.componentInstance.caption()).toBe('Coastal Shoot');
  });
});
