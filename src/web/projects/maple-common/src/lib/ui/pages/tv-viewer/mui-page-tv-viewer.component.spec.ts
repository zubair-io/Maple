import { TestBed } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';

import { MuiPageTvViewerComponent } from './mui-page-tv-viewer.component';

describe('MuiPageTvViewerComponent', () => {
  it('renders the Preview Surface with a position counter in Nav and a caption overlay', () => {
    const fixture = TestBed.createComponent(MuiPageTvViewerComponent);
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('mui-preview-surface')).toBeTruthy();
    expect(fixture.componentInstance.positionLabel()).toBe('1 of 3');
    expect(fixture.componentInstance.caption()).toBe('Wedding first look');
  });

  it('updates both the position counter and the caption when the active frame changes', () => {
    const fixture = TestBed.createComponent(MuiPageTvViewerComponent);
    fixture.detectChanges();

    fixture.componentInstance.onActiveChanged('tv2');
    fixture.detectChanges();

    expect(fixture.componentInstance.positionLabel()).toBe('3 of 3');
    expect(fixture.componentInstance.caption()).toBe('Wedding toast');
  });
});
