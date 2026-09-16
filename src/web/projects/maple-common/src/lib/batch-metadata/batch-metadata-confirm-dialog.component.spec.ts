import { TestBed } from '@angular/core/testing';
import { describe, expect, it, vi } from 'vitest';
import { BatchMetadataConfirmDialogComponent } from './batch-metadata-confirm-dialog.component';

function setup(applying = false, errors: Array<{ address: string; error: string }> = []) {
  const fixture = TestBed.createComponent(BatchMetadataConfirmDialogComponent);
  fixture.componentRef.setInput('visible', true);
  fixture.componentRef.setInput('applying', applying);
  fixture.componentRef.setInput('errors', errors);
  const confirm = vi.fn();
  const cancel = vi.fn();
  fixture.componentInstance.confirm.subscribe(confirm);
  fixture.componentInstance.cancel.subscribe(cancel);
  fixture.detectChanges();
  const buttons = Array.from(
    fixture.nativeElement.querySelectorAll('button'),
  ) as HTMLButtonElement[];
  return { fixture, buttons, confirm, cancel };
}

describe('batch metadata confirmation shared actions', () => {
  it('keeps focusable native actions and emits their distinct outputs', () => {
    const { buttons, confirm, cancel } = setup();
    expect(buttons.map((button) => button.textContent?.trim())).toEqual(['Cancel', 'Apply']);
    for (const button of buttons) {
      expect(button.type).toBe('button');
      expect(button.tabIndex).toBe(0);
      button.focus();
      expect(document.activeElement).toBe(button);
      button.click();
    }
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('suppresses both actions while applying', () => {
    const { buttons, confirm, cancel } = setup(true);
    expect(buttons[1].textContent).toContain('Applying…');
    for (const button of buttons) {
      expect(button.disabled).toBe(true);
      button.click();
    }
    expect(confirm).not.toHaveBeenCalled();
    expect(cancel).not.toHaveBeenCalled();
  });

  it('dismisses partial failures without applying the batch again', () => {
    const { buttons, confirm, cancel } = setup(false, [
      { address: 'photos:a.dng', error: 'Failed' },
    ]);
    expect(buttons).toHaveLength(1);
    expect(buttons[0].textContent?.trim()).toBe('Close');
    buttons[0].click();
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(confirm).not.toHaveBeenCalled();
  });
});
