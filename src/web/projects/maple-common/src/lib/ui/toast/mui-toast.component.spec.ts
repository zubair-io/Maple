// Uses vitest's fake timers (not Angular's `fakeAsync`, which the
// @angular/build:unit-test runner doesn't bundle zone-testing for — same
// convention as search.component.spec.ts) to pump the enter transition and
// auto-dismiss timers deterministically.

import { TestBed } from '@angular/core/testing';
import type { ComponentFixture } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MuiToastComponent } from './mui-toast.component';

function render(): ComponentFixture<MuiToastComponent> {
  TestBed.configureTestingModule({ imports: [MuiToastComponent] });
  const fixture = TestBed.createComponent(MuiToastComponent);
  fixture.componentRef.setInput('message', 'Saved');
  fixture.detectChanges();
  return fixture;
}

describe('MuiToastComponent', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('starts hidden and flips to entered on the next tick', () => {
    const fixture = render();
    expect(fixture.nativeElement.querySelector('.mui-toast').className).not.toContain('is-entered');

    vi.advanceTimersByTime(0);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.mui-toast').className).toContain('is-entered');
  });

  it('renders the variant icon and message', () => {
    const fixture = render();
    fixture.componentRef.setInput('variant', 'error');
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.mui-toast').className).toContain('variant-error');
    expect(fixture.nativeElement.querySelector('.message').textContent).toBe('Saved');
    expect(fixture.nativeElement.querySelector('mui-icon')).toBeTruthy();
  });

  it('auto-dismisses after autoDismissMs, emitting dismissed once the exit motion finishes', () => {
    const fixture = render();
    fixture.componentRef.setInput('autoDismissMs', 3000);
    fixture.detectChanges();

    let dismissedCount = 0;
    fixture.componentInstance.dismissed.subscribe(() => dismissedCount++);

    vi.advanceTimersByTime(3000);
    fixture.detectChanges();
    expect(fixture.componentInstance.leaving()).toBe(true);
    expect(dismissedCount).toBe(0);

    vi.advanceTimersByTime(280); // sheetDismiss motion duration
    expect(dismissedCount).toBe(1);
  });

  it('never auto-dismisses when autoDismissMs is null', () => {
    const fixture = render();
    fixture.componentRef.setInput('autoDismissMs', null);
    fixture.detectChanges();
    let dismissedCount = 0;
    fixture.componentInstance.dismissed.subscribe(() => dismissedCount++);

    vi.advanceTimersByTime(60_000);
    expect(dismissedCount).toBe(0);
    expect(fixture.componentInstance.leaving()).toBe(false);
  });

  it('the close button dismisses immediately regardless of the auto-dismiss timer', () => {
    const fixture = render();
    fixture.componentRef.setInput('autoDismissMs', 10_000);
    fixture.detectChanges();
    let dismissedCount = 0;
    fixture.componentInstance.dismissed.subscribe(() => dismissedCount++);

    (fixture.nativeElement.querySelector('.close') as HTMLButtonElement).click();
    fixture.detectChanges();
    expect(fixture.componentInstance.leaving()).toBe(true);

    vi.advanceTimersByTime(280);
    expect(dismissedCount).toBe(1);

    // The auto-dismiss timer was cleared, so firing its original deadline
    // must not double-dismiss.
    vi.advanceTimersByTime(10_000);
    expect(dismissedCount).toBe(1);
  });

  it('renders an action button and emits actionPressed on click', () => {
    const fixture = render();
    fixture.componentRef.setInput('actionLabel', 'Undo');
    fixture.detectChanges();
    let pressed = 0;
    fixture.componentInstance.actionPressed.subscribe(() => pressed++);

    (fixture.nativeElement.querySelector('.action') as HTMLButtonElement).click();
    expect(pressed).toBe(1);
  });

  it('omits the action button when no actionLabel is given', () => {
    const fixture = render();
    expect(fixture.nativeElement.querySelector('.action')).toBeNull();
  });

  it('omits the close button when dismissible is false', () => {
    const fixture = render();
    fixture.componentRef.setInput('dismissible', false);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.close')).toBeNull();
  });

  it('renders the close button by default', () => {
    const fixture = render();
    expect(fixture.nativeElement.querySelector('.close')).not.toBeNull();
  });

  it('sets aria-label on the host when given, leaving it absent otherwise', () => {
    const fixture = render();
    expect(fixture.nativeElement.getAttribute('aria-label')).toBeNull();

    fixture.componentRef.setInput('ariaLabel', 'Single-file save');
    fixture.detectChanges();
    expect(fixture.nativeElement.getAttribute('aria-label')).toBe('Single-file save');
  });

  it('applies the glass surface class when surface is "glass"', () => {
    const fixture = render();
    fixture.componentRef.setInput('surface', 'glass');
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.mui-toast').className).toContain('surface-glass');
  });
});
