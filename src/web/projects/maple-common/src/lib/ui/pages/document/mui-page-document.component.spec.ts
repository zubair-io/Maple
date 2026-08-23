import { TestBed } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';

import { MuiPageDocumentComponent } from './mui-page-document.component';

describe('MuiPageDocumentComponent', () => {
  it('renders Sidebar, Rich Text Editor, and a Backlinks Panel in Detail by default', () => {
    const fixture = TestBed.createComponent(MuiPageDocumentComponent);
    fixture.detectChanges();

    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('[slot=sidebar] mui-sidebar')).toBeTruthy();
    expect(el.querySelector('mui-rich-text-editor')).toBeTruthy();
    expect(el.querySelector('[slot=detail] mui-backlinks-panel')).toBeTruthy();
    expect(el.querySelector('[slot=detail] mui-version-history-panel')).toBeNull();
  });

  it('swaps the Rich Text Editor content and Detail data when the Sidebar selection changes', () => {
    const fixture = TestBed.createComponent(MuiPageDocumentComponent);
    fixture.detectChanges();

    const tripValue = fixture.componentInstance.displayedValue();
    fixture.componentInstance.sidebarActiveId.set('meeting');
    fixture.detectChanges();

    expect(fixture.componentInstance.displayedValue()).not.toBe(tripValue);
    expect(fixture.componentInstance.displayedValue()).toContain('fall release');
    expect(fixture.componentInstance.backlinks()[0]?.label).toBe('Q3 Planning');
  });

  it('switches Detail to Version History when its tab is selected', () => {
    const fixture = TestBed.createComponent(MuiPageDocumentComponent);
    fixture.detectChanges();

    fixture.componentInstance.detailActiveTab.set('history');
    fixture.detectChanges();

    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('[slot=detail] mui-version-history-panel')).toBeTruthy();
    expect(el.querySelector('[slot=detail] mui-backlinks-panel')).toBeNull();
  });
});
