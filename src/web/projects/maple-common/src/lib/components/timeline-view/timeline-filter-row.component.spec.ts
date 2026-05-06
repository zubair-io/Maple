// TimelineFilterRow — clicking a star pill mutates state.minRating(), clicking
// the same star a second time clears it, and Clear resets everything.

import { TestBed } from '@angular/core/testing';
import { describe, it, expect, beforeEach } from 'vitest';

import { TimelineFilterRowComponent } from './timeline-filter-row.component';
import { TimelineStateService } from '../../state/timeline-state.service';
import { LIBRARY_BACKEND } from '../../api/library-backend.token';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';

describe('TimelineFilterRowComponent', () => {
  let state: TimelineStateService;
  let fixture: ReturnType<typeof TestBed.createComponent<TimelineFilterRowComponent>>;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: LIBRARY_BACKEND, useValue: 'self-hosted' },
      ],
    });
    state = TestBed.inject(TimelineStateService);
    fixture = TestBed.createComponent(TimelineFilterRowComponent);
    fixture.detectChanges();
  });

  function clickRating(n: number): void {
    const buttons = fixture.nativeElement.querySelectorAll(
      '[aria-label$="stars or more"]',
    ) as NodeListOf<HTMLButtonElement>;
    // Buttons are rendered in [1..5] order (STAR_INDICES); zero-indexed array.
    buttons[n - 1]!.click();
    fixture.detectChanges();
  }

  it('renders 5 rating pills', () => {
    const buttons = fixture.nativeElement.querySelectorAll('[aria-label$="stars or more"]');
    expect(buttons.length).toBe(5);
  });

  it('clicking ★4 sets minRating to 4', () => {
    expect(state.minRating()).toBe(0);
    clickRating(4);
    expect(state.minRating()).toBe(4);
  });

  it('clicking the same star twice clears the rating', () => {
    clickRating(3);
    expect(state.minRating()).toBe(3);
    clickRating(3);
    expect(state.minRating()).toBe(0);
  });

  it('clicking Clear resets every filter', () => {
    state.setMinRating(5);
    state.setFlag('pick');
    state.setColor('red');
    state.setFrom('2025-01-01');
    state.setTo('2025-12-31');
    fixture.detectChanges();

    const clearBtn = Array.from(
      fixture.nativeElement.querySelectorAll('button') as NodeListOf<HTMLButtonElement>,
    ).find((b) => b.textContent?.trim() === 'Clear');
    expect(clearBtn).toBeTruthy();
    clearBtn!.click();
    fixture.detectChanges();

    expect(state.minRating()).toBe(0);
    expect(state.flag()).toBe('');
    expect(state.color()).toBe('');
    expect(state.from()).toBe('');
    expect(state.to()).toBe('');
  });

  it('flag pills are exposed via aria-pressed (S5)', () => {
    state.setFlag('pick');
    fixture.detectChanges();
    const pickBtn = Array.from(
      fixture.nativeElement.querySelectorAll('button') as NodeListOf<HTMLButtonElement>,
    ).find((b) => b.textContent?.trim() === 'Pick');
    expect(pickBtn?.getAttribute('aria-pressed')).toBe('true');
  });
});
