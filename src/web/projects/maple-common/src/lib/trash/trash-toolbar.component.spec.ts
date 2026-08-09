import { TestBed } from '@angular/core/testing';
import { describe, it, expect } from 'vitest';
import { TrashToolbarComponent } from './trash-toolbar.component';

describe('TrashToolbarComponent', () => {
  function setup(disabledReason: string | null = null) {
    const fixture = TestBed.createComponent(TrashToolbarComponent);
    fixture.componentRef.setInput('disabledReason', disabledReason);
    fixture.detectChanges();
    return fixture;
  }

  it('enables both buttons and exposes no reason when not disabled', () => {
    const fixture = setup(null);
    const buttons: HTMLButtonElement[] = Array.from(
      fixture.nativeElement.querySelectorAll('button'),
    );
    expect(buttons.every((b) => !b.disabled)).toBe(true);
    expect(fixture.nativeElement.querySelector('#tt-disabled-reason')).toBeNull();
  });

  it('disables both buttons and exposes the reason via title + aria-describedby', () => {
    const fixture = setup('Trash is empty.');
    const buttons: HTMLButtonElement[] = Array.from(
      fixture.nativeElement.querySelectorAll('button'),
    );
    expect(buttons.every((b) => b.disabled)).toBe(true);
    expect(buttons.every((b) => b.title === 'Trash is empty.')).toBe(true);
    expect(buttons.every((b) => b.getAttribute('aria-describedby') === 'tt-disabled-reason')).toBe(
      true,
    );
    const reasonEl = fixture.nativeElement.querySelector('#tt-disabled-reason');
    expect(reasonEl?.textContent).toBe('Trash is empty.');
  });

  it('emits restoreAll and emptyTrash on click', () => {
    const fixture = setup(null);
    let restoreCalled = false;
    let emptyCalled = false;
    fixture.componentInstance.restoreAll.subscribe(() => (restoreCalled = true));
    fixture.componentInstance.emptyTrash.subscribe(() => (emptyCalled = true));
    const buttons: HTMLButtonElement[] = Array.from(
      fixture.nativeElement.querySelectorAll('button'),
    );
    buttons[0].click();
    buttons[1].click();
    expect(restoreCalled).toBe(true);
    expect(emptyCalled).toBe(true);
  });
});
