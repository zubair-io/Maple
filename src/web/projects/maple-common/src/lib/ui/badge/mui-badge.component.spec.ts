import { TestBed } from '@angular/core/testing';
import type { ComponentFixture } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';

import { MuiBadgeComponent } from './mui-badge.component';

function render(): ComponentFixture<MuiBadgeComponent> {
  TestBed.configureTestingModule({ imports: [MuiBadgeComponent] });
  const fixture = TestBed.createComponent(MuiBadgeComponent);
  fixture.componentRef.setInput('value', 3);
  fixture.detectChanges();
  return fixture;
}

describe('MuiBadgeComponent', () => {
  it('renders the count variant as a filled pill with the value text', () => {
    const fixture = render();
    const pill = fixture.nativeElement.querySelector('.pill') as HTMLElement;
    expect(pill).toBeTruthy();
    expect(pill.className).toContain('variant-count');
    expect(pill.textContent?.trim()).toBe('3');
  });

  it('switches variant classes for signal, and renders a non-pill star glyph for rating', () => {
    const fixture = render();
    fixture.componentRef.setInput('variant', 'signal');
    fixture.detectChanges();
    expect((fixture.nativeElement.querySelector('.pill') as HTMLElement).className).toContain(
      'variant-signal',
    );

    fixture.componentRef.setInput('variant', 'rating');
    fixture.componentRef.setInput('value', 4.5);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.pill')).toBeNull();
    const rating = fixture.nativeElement.querySelector('.rating') as HTMLElement;
    expect(rating).toBeTruthy();
    expect(rating.querySelector('mui-icon')).toBeTruthy();
    expect(rating.querySelector('.value')?.textContent).toBe('4.5');
  });

  it('exposes an accessible label — an explicit override, or falling back to "<value> rating" for the rating variant', () => {
    const fixture = render();
    fixture.componentRef.setInput('label', '3 unread');
    fixture.detectChanges();
    expect(
      (fixture.nativeElement.querySelector('.pill') as HTMLElement).getAttribute('aria-label'),
    ).toBe('3 unread');

    fixture.componentRef.setInput('variant', 'rating');
    fixture.componentRef.setInput('label', null);
    fixture.componentRef.setInput('value', 4);
    fixture.detectChanges();
    expect(
      (fixture.nativeElement.querySelector('.rating') as HTMLElement).getAttribute('aria-label'),
    ).toBe('4 rating');
  });

  it('reflects the size input as a rendered class', () => {
    const fixture = render();
    fixture.componentRef.setInput('size', 'sm');
    fixture.detectChanges();
    expect((fixture.nativeElement.querySelector('.pill') as HTMLElement).className).toContain(
      'size-sm',
    );
  });
});
