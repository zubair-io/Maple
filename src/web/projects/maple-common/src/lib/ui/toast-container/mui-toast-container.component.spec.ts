import { TestBed } from '@angular/core/testing';
import type { ComponentFixture } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MuiToastContainerComponent } from './mui-toast-container.component';
import type { MuiToastEntry } from './mui-toast-container.component';

const TOASTS: readonly MuiToastEntry[] = [
  { id: 'a', variant: 'success', message: 'Export finished', autoDismissMs: null },
  { id: 'b', variant: 'info', message: 'Syncing…', autoDismissMs: null },
];

function render(): ComponentFixture<MuiToastContainerComponent> {
  TestBed.configureTestingModule({ imports: [MuiToastContainerComponent] });
  const fixture = TestBed.createComponent(MuiToastContainerComponent);
  fixture.componentRef.setInput('toasts', TOASTS);
  fixture.detectChanges();
  return fixture;
}

describe('MuiToastContainerComponent', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('stacks one mui-toast per entry, in order', () => {
    const fixture = render();
    const toasts = fixture.nativeElement.querySelectorAll('mui-toast');
    expect(toasts.length).toBe(2);
    expect(toasts[0].textContent).toContain('Export finished');
    expect(toasts[1].textContent).toContain('Syncing');
  });

  it('applies a growing exit-transition delay per slot so a mass-dismiss cascades', () => {
    const fixture = render();
    const slots = fixture.nativeElement.querySelectorAll('.slot');
    expect((slots[0] as HTMLElement).style.transitionDelay).toBe('0ms');
    expect((slots[1] as HTMLElement).style.transitionDelay).toBe('60ms');
  });

  it('forwards dismissed with the entry id once the toast finishes its exit motion', () => {
    const fixture = render();
    const dismissed: string[] = [];
    fixture.componentInstance.dismissed.subscribe((id) => dismissed.push(id));

    const firstToastDismiss = fixture.nativeElement.querySelector(
      'mui-toast [aria-label="Dismiss"]',
    ) as HTMLButtonElement | null;
    expect(firstToastDismiss).toBeTruthy();
    firstToastDismiss!.click();
    vi.advanceTimersByTime(280); // sheetDismiss motion duration
    expect(dismissed).toEqual(['a']);
  });

  it('positions the stack via a position-* class, defaulting to bottom-right', () => {
    const fixture = render();
    const el = fixture.nativeElement.querySelector('.mui-toast-container');
    expect(el.className).toContain('position-bottom-right');

    fixture.componentRef.setInput('position', 'top-right');
    fixture.detectChanges();
    expect(el.className).toContain('position-top-right');
  });

  it('the `inline` input switches from fixed to absolute positioning', () => {
    const fixture = render();
    fixture.componentRef.setInput('inline', true);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.mui-toast-container').className).toContain(
      'is-inline',
    );
  });
});
