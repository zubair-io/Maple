import { TestBed } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';

import { MuiDragPreviewComponent } from './mui-drag-preview.component';

describe('MuiDragPreviewComponent', () => {
  it('renders the thumbnail with no count badge for a single-item drag', () => {
    const fixture = TestBed.createComponent(MuiDragPreviewComponent);
    fixture.componentRef.setInput('src', 'data:image/png;base64,AAAA');
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('mui-image')).toBeTruthy();
    expect(fixture.nativeElement.querySelector('mui-badge')).toBeNull();
  });

  it('shows a count badge once more than one item is being dragged', () => {
    const fixture = TestBed.createComponent(MuiDragPreviewComponent);
    fixture.componentRef.setInput('src', 'data:image/png;base64,AAAA');
    fixture.componentRef.setInput('count', 5);
    fixture.detectChanges();

    const badge = fixture.nativeElement.querySelector('mui-badge .mui-badge');
    expect(badge.textContent.trim()).toBe('5');
  });

  it('is not a pointer-event target, so it never intercepts drop-target events', () => {
    const fixture = TestBed.createComponent(MuiDragPreviewComponent);
    fixture.componentRef.setInput('src', 'data:image/png;base64,AAAA');
    fixture.detectChanges();

    const style = getComputedStyle(fixture.nativeElement);
    expect(style.pointerEvents).toBe('none');
  });
});
