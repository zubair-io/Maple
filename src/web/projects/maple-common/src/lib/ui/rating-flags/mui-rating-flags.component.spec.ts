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

  describe('pills variant', () => {
    it('renders three direct-select pills instead of the single cycling flag button', () => {
      const fixture = render();
      fixture.componentRef.setInput('variant', 'pills');
      fixture.detectChanges();
      expect(fixture.nativeElement.querySelector('.flag')).toBeNull();
      expect(fixture.nativeElement.querySelectorAll('.pill').length).toBe(3);
    });

    it('clicking a pill jumps straight to that state, no cycling', () => {
      const fixture = render();
      fixture.componentRef.setInput('variant', 'pills');
      fixture.detectChanges();
      const pills = fixture.nativeElement.querySelectorAll('.pill');
      (pills[2] as HTMLButtonElement).click(); // reject pill
      fixture.detectChanges();
      expect(fixture.componentInstance.flag()).toBe('reject');

      (pills[0] as HTMLButtonElement).click(); // pick pill, straight from reject
      fixture.detectChanges();
      expect(fixture.componentInstance.flag()).toBe('pick');
    });

    it('disabled blocks pill clicks too', () => {
      const fixture = render();
      fixture.componentRef.setInput('variant', 'pills');
      fixture.componentRef.setInput('disabled', true);
      fixture.detectChanges();
      const pills = fixture.nativeElement.querySelectorAll('.pill');
      (pills[2] as HTMLButtonElement).click();
      fixture.detectChanges();
      expect(fixture.componentInstance.flag()).toBe('none');
    });
  });

  describe('readonly display', () => {
    function renderReadonly(): ComponentFixture<MuiRatingFlagsComponent> {
      const fixture = render();
      fixture.componentRef.setInput('readonly', true);
      fixture.detectChanges();
      return fixture;
    }

    it('renders no buttons, slider, or any other focusable control', () => {
      const fixture = renderReadonly();
      expect(fixture.nativeElement.querySelector('button')).toBeNull();
      expect(fixture.nativeElement.querySelector('[role="slider"]')).toBeNull();
      expect(fixture.nativeElement.querySelector('[tabindex]')).toBeNull();
    });

    it('renders no star row and no flag chip at the zero/none defaults', () => {
      const fixture = renderReadonly();
      expect(fixture.nativeElement.querySelector('.star-row')).toBeNull();
      expect(fixture.nativeElement.querySelector('.flag-chip')).toBeNull();
    });

    it('renders a PICK chip when flag is pick, and nothing for reject', () => {
      const fixture = renderReadonly();
      fixture.componentRef.setInput('flag', 'pick');
      fixture.detectChanges();
      const chip = fixture.nativeElement.querySelector('.flag-chip') as HTMLElement;
      expect(chip.textContent).toBe('PICK');
      expect(chip.classList.contains('pick')).toBe(true);
    });

    it('renders a REJECT chip when flag is reject', () => {
      const fixture = renderReadonly();
      fixture.componentRef.setInput('flag', 'reject');
      fixture.detectChanges();
      const chip = fixture.nativeElement.querySelector('.flag-chip') as HTMLElement;
      expect(chip.textContent).toBe('REJECT');
      expect(chip.classList.contains('reject')).toBe(true);
    });

    it('renders a 5-icon star row, filled up to the rating, once rating is above zero', () => {
      const fixture = renderReadonly();
      fixture.componentRef.setInput('rating', 3);
      fixture.detectChanges();
      const icons = fixture.nativeElement.querySelectorAll('.star-row maple-icon');
      expect(icons.length).toBe(5);
    });

    it('never emits rating/flag model changes from readonly clicks (no click handlers wired)', () => {
      const fixture = renderReadonly();
      fixture.componentRef.setInput('rating', 2);
      fixture.componentRef.setInput('flag', 'pick');
      fixture.detectChanges();
      const display = fixture.nativeElement.querySelector(
        '.mui-rating-flags-display',
      ) as HTMLElement;
      display.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      fixture.detectChanges();
      expect(fixture.componentInstance.rating()).toBe(2);
      expect(fixture.componentInstance.flag()).toBe('pick');
    });
  });
});
