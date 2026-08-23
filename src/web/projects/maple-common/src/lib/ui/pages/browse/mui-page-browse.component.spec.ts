import { TestBed } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';

import { MuiPageBrowseComponent } from './mui-page-browse.component';

describe('MuiPageBrowseComponent', () => {
  it('renders Sidebar in the Split Layout sidebar slot and Collection Grid in Center by default', () => {
    const fixture = TestBed.createComponent(MuiPageBrowseComponent);
    fixture.detectChanges();

    const sidebarSlot = fixture.nativeElement.querySelector('[slot=sidebar] mui-sidebar');
    expect(sidebarSlot).toBeTruthy();
    expect(fixture.nativeElement.querySelector('mui-collection-grid')).toBeTruthy();
    expect(fixture.nativeElement.querySelector('mui-timeline')).toBeNull();
    expect(fixture.nativeElement.querySelector('mui-map-surface')).toBeNull();
  });

  it('filters the visible photos to the active Sidebar folder', () => {
    const fixture = TestBed.createComponent(MuiPageBrowseComponent);
    fixture.detectChanges();

    expect(fixture.componentInstance.visiblePhotos().every((p) => p.id.startsWith('ballet'))).toBe(
      true,
    );

    fixture.componentInstance.sidebarActiveId.set('coastal');
    fixture.detectChanges();

    const photos = fixture.componentInstance.visiblePhotos();
    expect(photos.length).toBeGreaterThan(0);
    expect(photos.every((p) => p.id.startsWith('coastal'))).toBe(true);
  });

  it('switches the Center region organism when the view Toolbar is used', () => {
    const fixture = TestBed.createComponent(MuiPageBrowseComponent);
    fixture.detectChanges();

    fixture.componentInstance.onViewSelected('timeline');
    fixture.detectChanges();
    // Timeline is itself built from Collection Grid internally, so assert
    // on direct children of `.view-body` rather than "no collection-grid
    // anywhere in the DOM".
    expect(fixture.nativeElement.querySelector('.view-body > mui-timeline')).toBeTruthy();
    expect(fixture.nativeElement.querySelector('.view-body > mui-collection-grid')).toBeNull();

    fixture.componentInstance.onViewSelected('map');
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.view-body > mui-map-surface')).toBeTruthy();
  });
});
