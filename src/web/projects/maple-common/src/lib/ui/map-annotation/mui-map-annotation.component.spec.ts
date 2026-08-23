import { TestBed } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';

import { MuiMapAnnotationComponent } from './mui-map-annotation.component';

describe('MuiMapAnnotationComponent', () => {
  it('shows the fallback pin glyph when no thumbnail src is given', () => {
    const fixture = TestBed.createComponent(MuiMapAnnotationComponent);
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('mui-icon')).toBeTruthy();
    expect(fixture.nativeElement.querySelector('mui-image')).toBeNull();
  });

  it('shows the thumbnail image instead of the glyph once a src is given', () => {
    const fixture = TestBed.createComponent(MuiMapAnnotationComponent);
    fixture.componentRef.setInput('src', 'data:image/png;base64,AAAA');
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('mui-image')).toBeTruthy();
    expect(fixture.nativeElement.querySelector('mui-icon')).toBeNull();
  });

  it('renders a count badge only when count is a positive number', () => {
    const fixture = TestBed.createComponent(MuiMapAnnotationComponent);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('mui-badge')).toBeNull();

    fixture.componentRef.setInput('count', 0);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('mui-badge')).toBeNull();

    fixture.componentRef.setInput('count', 12);
    fixture.detectChanges();
    const badge = fixture.nativeElement.querySelector('mui-badge .mui-badge');
    expect(badge.textContent.trim()).toBe('12');
  });

  it('renders an optional caption below the pin', () => {
    const fixture = TestBed.createComponent(MuiMapAnnotationComponent);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.caption')).toBeNull();

    fixture.componentRef.setInput('label', 'Golden Gate Park');
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.caption').textContent.trim()).toBe(
      'Golden Gate Park',
    );
  });
});
