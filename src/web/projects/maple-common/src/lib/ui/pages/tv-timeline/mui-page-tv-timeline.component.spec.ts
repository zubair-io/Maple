import { TestBed } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';

import { MuiPageTvTimelineComponent } from './mui-page-tv-timeline.component';

describe('MuiPageTvTimelineComponent', () => {
  it('renders the Timeline organism by default and Collection Grid on the Collections tab', () => {
    const fixture = TestBed.createComponent(MuiPageTvTimelineComponent);
    fixture.detectChanges();

    // Timeline is itself built from Collection Grid internally, so assert
    // on direct children of `.tab-content` rather than "no collection-grid
    // anywhere in the DOM".
    expect(fixture.nativeElement.querySelector('.tab-content > mui-timeline')).toBeTruthy();
    expect(fixture.nativeElement.querySelector('.tab-content > mui-collection-grid')).toBeNull();

    fixture.componentInstance.activeTabId.set('collections');
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('.tab-content > mui-collection-grid')).toBeTruthy();
    expect(fixture.nativeElement.querySelector('.tab-content > mui-timeline')).toBeNull();
  });

  it('keeps the same active filter shared across both the Timeline and Collection Grid tabs', () => {
    const fixture = TestBed.createComponent(MuiPageTvTimelineComponent);
    fixture.detectChanges();

    fixture.componentInstance.activeFilterId.set('places');
    fixture.detectChanges();

    const timelinePhotoCount = fixture.componentInstance
      .timelineGroups()
      .reduce((sum, g) => sum + g.items.length, 0);
    expect(timelinePhotoCount).toBe(2);

    fixture.componentInstance.activeTabId.set('collections');
    fixture.detectChanges();

    expect(fixture.componentInstance.collectionItems().length).toBe(2);
  });
});
