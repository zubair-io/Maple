import { TestBed } from '@angular/core/testing';
import type { ComponentFixture } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';

import { MuiRatingFlagsComponent } from './mui-rating-flags.component';

function render(): ComponentFixture<MuiRatingFlagsComponent> {
  TestBed.configureTestingModule({ imports: [MuiRatingFlagsComponent] });
  const fixture = TestBed.createComponent(MuiRatingFlagsComponent);
  fixture.detectChanges();
  return fixture;
}

describe('MuiRatingFlagsComponent', () => {
  it('shows a numeric rating badge once the rating is above zero, and hides it at zero', () => {
    const fixture = render();
    expect(fixture.nativeElement.querySelector('mui-badge')).toBeNull();

    fixture.componentRef.setInput('rating', 4);
    fixture.detectChanges();
    const badge = fixture.nativeElement.querySelector('mui-badge');
    expect(badge).toBeTruthy();
    expect(badge.textContent).toContain('4');
  });

  it('renders 5 stars by default', () => {
    const fixture = render();
    expect(fixture.nativeElement.querySelectorAll('.star').length).toBe(5);
  });

  it('clicking a star sets the rating to that star index', () => {
    const fixture = render();
    const stars = fixture.nativeElement.querySelectorAll('.star');
    (stars[2] as HTMLButtonElement).click(); // third star
    fixture.detectChanges();
    expect(fixture.componentInstance.rating()).toBe(3);
  });

  it('clicking the current top star again clears the rating', () => {
    const fixture = render();
    fixture.componentRef.setInput('rating', 3);
    fixture.detectChanges();
    const stars = fixture.nativeElement.querySelectorAll('.star');
    (stars[2] as HTMLButtonElement).click();
    fixture.detectChanges();
    expect(fixture.componentInstance.rating()).toBe(2);
  });

  it('ArrowRight/ArrowLeft on the star group nudge the rating by one, clamped', () => {
    const fixture = render();
    const group = fixture.nativeElement.querySelector('.stars') as HTMLElement;
    group.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    group.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    fixture.detectChanges();
    expect(fixture.componentInstance.rating()).toBe(2);

    group.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
    fixture.detectChanges();
    expect(fixture.componentInstance.rating()).toBe(1);
  });

  it('clicking the flag cycles none -> pick -> reject -> none', () => {
    const fixture = render();
    const flagBtn = fixture.nativeElement.querySelector('.flag') as HTMLButtonElement;
    expect(fixture.componentInstance.flag()).toBe('none');

    flagBtn.click();
    fixture.detectChanges();
    expect(fixture.componentInstance.flag()).toBe('pick');

    flagBtn.click();
    fixture.detectChanges();
    expect(fixture.componentInstance.flag()).toBe('reject');

    flagBtn.click();
    fixture.detectChanges();
    expect(fixture.componentInstance.flag()).toBe('none');
  });

  it('disabled blocks star clicks, keyboard nudges, and flag cycling', () => {
    const fixture = render();
    fixture.componentRef.setInput('disabled', true);
    fixture.detectChanges();
    const stars = fixture.nativeElement.querySelectorAll('.star');
    (stars[3] as HTMLButtonElement).click();
    fixture.nativeElement
      .querySelector('.flag')
      .dispatchEvent(new MouseEvent('click', { bubbles: true }));
    fixture.detectChanges();
    expect(fixture.componentInstance.rating()).toBe(0);
    expect(fixture.componentInstance.flag()).toBe('none');
  });
});
