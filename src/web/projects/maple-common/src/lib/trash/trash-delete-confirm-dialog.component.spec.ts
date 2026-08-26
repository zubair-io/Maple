import { TestBed } from '@angular/core/testing';
import type { ComponentFixture } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';

import { TrashDeleteConfirmDialogComponent } from './trash-delete-confirm-dialog.component';

function render(): ComponentFixture<TrashDeleteConfirmDialogComponent> {
  TestBed.configureTestingModule({ imports: [TrashDeleteConfirmDialogComponent] });
  const fixture = TestBed.createComponent(TrashDeleteConfirmDialogComponent);
  fixture.componentRef.setInput('targetLabel', 'photo.dng');
  fixture.detectChanges();
  return fixture;
}

describe('TrashDeleteConfirmDialogComponent', () => {
  it('names the target in the message and renders as a destructive alertdialog', () => {
    const fixture = render();
    expect(fixture.nativeElement.textContent).toContain('photo.dng');
    expect(fixture.nativeElement.querySelector('.mui-dialog').getAttribute('role')).toBe(
      'alertdialog',
    );
  });

  it('swaps the confirm label to "Deleting…" while busy, and back once idle', () => {
    const fixture = render();
    const confirmButton = () =>
      fixture.nativeElement.querySelectorAll('.actions button')[1] as HTMLButtonElement;
    expect(confirmButton().textContent).toContain('Delete Permanently');

    fixture.componentRef.setInput('busy', true);
    fixture.detectChanges();
    expect(confirmButton().textContent).toContain('Deleting…');
  });

  it('shows the server error inline when set', () => {
    const fixture = render();
    fixture.componentRef.setInput('serverError', 'Permission denied');
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.error-message').textContent).toContain(
      'Permission denied',
    );
  });

  it('emits confirmDelete on Confirm and dismiss on Cancel', () => {
    const fixture = render();
    const confirms: void[] = [];
    const dismisses: void[] = [];
    fixture.componentInstance.confirmDelete.subscribe(() => confirms.push(undefined));
    fixture.componentInstance.dismiss.subscribe(() => dismisses.push(undefined));

    const buttons = fixture.nativeElement.querySelectorAll('.actions button');
    (buttons[0] as HTMLButtonElement).click();
    (buttons[1] as HTMLButtonElement).click();

    expect(dismisses.length).toBe(1);
    expect(confirms.length).toBe(1);
  });
});
