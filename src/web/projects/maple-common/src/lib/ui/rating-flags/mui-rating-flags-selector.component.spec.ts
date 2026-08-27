import { TestBed } from '@angular/core/testing';
import type { ComponentFixture } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';

import { MuiRatingFlagsSelectorComponent } from './mui-rating-flags-selector.component';

function render(): ComponentFixture<MuiRatingFlagsSelectorComponent> {
  TestBed.configureTestingModule({ imports: [MuiRatingFlagsSelectorComponent] });
  const fixture = TestBed.createComponent(MuiRatingFlagsSelectorComponent);
  fixture.detectChanges();
  return fixture;
}

describe('MuiRatingFlagsSelectorComponent', () => {
  it('renders the single cycling flag button by default', () => {
    const fixture = render();
    expect(fixture.nativeElement.querySelector('.flag')).toBeTruthy();
    expect(fixture.nativeElement.querySelector('.pill')).toBeNull();
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

  it('disabled blocks flag cycling', () => {
    const fixture = render();
    fixture.componentRef.setInput('disabled', true);
    fixture.detectChanges();
    (fixture.nativeElement.querySelector('.flag') as HTMLButtonElement).click();
    fixture.detectChanges();
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
});
