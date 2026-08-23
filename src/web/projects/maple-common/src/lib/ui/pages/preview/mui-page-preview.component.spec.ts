import { TestBed } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';

import { MuiPagePreviewComponent } from './mui-page-preview.component';

describe('MuiPagePreviewComponent', () => {
  it('renders the Preview Surface inside App Shell Content', () => {
    const fixture = TestBed.createComponent(MuiPagePreviewComponent);
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('mui-preview-surface')).toBeTruthy();
    expect(fixture.nativeElement.querySelector('[slot=nav] mui-page-header')).toBeTruthy();
  });

  it('updates the Page Header title when the Preview Surface reports a new active frame', () => {
    const fixture = TestBed.createComponent(MuiPagePreviewComponent);
    fixture.detectChanges();

    const initialTitle = fixture.componentInstance.headerTitle();
    fixture.componentInstance.onActiveChanged('p2');
    fixture.detectChanges();

    expect(fixture.componentInstance.headerTitle()).not.toBe(initialTitle);
    expect(fixture.componentInstance.headerTitle()).toContain('frame 3');
  });
});
