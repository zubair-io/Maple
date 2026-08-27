import { TestBed } from '@angular/core/testing';
import type { ComponentFixture } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';

import { MuiRatingFlagsDisplayComponent } from './mui-rating-flags-display.component';

function render(): ComponentFixture<MuiRatingFlagsDisplayComponent> {
  TestBed.configureTestingModule({ imports: [MuiRatingFlagsDisplayComponent] });
  const fixture = TestBed.createComponent(MuiRatingFlagsDisplayComponent);
  fixture.detectChanges();
  return fixture;
}

describe('MuiRatingFlagsDisplayComponent', () => {
  it('renders no buttons or focusable controls at all', () => {
    const fixture = render();
    expect(fixture.nativeElement.querySelector('button')).toBeNull();
    expect(fixture.nativeElement.querySelector('[tabindex]')).toBeNull();
  });

  it('renders nothing at the zero-rating/none-flag defaults', () => {
    const fixture = render();
    expect(fixture.nativeElement.querySelector('.star-row')).toBeNull();
    expect(fixture.nativeElement.querySelector('.flag-chip')).toBeNull();
  });

  it('renders a PICK chip when flag is pick', () => {
    const fixture = render();
    fixture.componentRef.setInput('flag', 'pick');
    fixture.detectChanges();
    const chip = fixture.nativeElement.querySelector('.flag-chip') as HTMLElement;
    expect(chip.textContent).toBe('PICK');
    expect(chip.classList.contains('pick')).toBe(true);
  });

  it('renders a REJECT chip when flag is reject', () => {
    const fixture = render();
    fixture.componentRef.setInput('flag', 'reject');
    fixture.detectChanges();
    const chip = fixture.nativeElement.querySelector('.flag-chip') as HTMLElement;
    expect(chip.textContent).toBe('REJECT');
    expect(chip.classList.contains('reject')).toBe(true);
  });

  it('renders a star row sized to `max`, filled up to `rating`', () => {
    const fixture = render();
    fixture.componentRef.setInput('rating', 2);
    fixture.componentRef.setInput('max', 3);
    fixture.detectChanges();
    const icons = fixture.nativeElement.querySelectorAll('.star-row maple-icon');
    expect(icons.length).toBe(3);
  });
});
