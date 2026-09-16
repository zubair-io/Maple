import { TestBed } from '@angular/core/testing';
import { describe, expect, it, vi } from 'vitest';
import { TrashItemRowComponent } from './trash-item-row.component';
import type { TrashItem } from './trash.types';

function setup(reason: TrashItem['reason'] = 'user') {
  const fixture = TestBed.createComponent(TrashItemRowComponent);
  fixture.componentRef.setInput('item', {
    assetId: 'photo-id',
    filename: 'photo.dng',
    originalRelativePath: 'photos/photo.dng',
    trashRelativePath: '.maple/trash/photo.dng',
    size: 1024,
    mtime: '2026-09-16',
    deletedAt: '2026-09-16',
    reason,
  });
  const restore = vi.fn();
  const remove = vi.fn();
  fixture.componentInstance.restore.subscribe(restore);
  fixture.componentInstance.deletePermanently.subscribe(remove);
  fixture.detectChanges();
  const buttons = Array.from(
    fixture.nativeElement.querySelectorAll('button'),
  ) as HTMLButtonElement[];
  return { fixture, buttons, restore, remove };
}

describe('Trash row shared actions', () => {
  it('preserves filename-specific native names and suppresses pending actions', () => {
    const { fixture, buttons, restore, remove } = setup();
    expect(buttons.map((button) => button.getAttribute('aria-label'))).toEqual([
      'Restore photo.dng',
      'Delete photo.dng permanently',
    ]);
    buttons[0].click();
    buttons[1].click();
    expect(restore).toHaveBeenCalledTimes(1);
    expect(remove).toHaveBeenCalledTimes(1);
    fixture.componentRef.setInput('busy', true);
    fixture.detectChanges();
    for (const button of buttons) {
      expect(button.disabled).toBe(true);
      button.click();
    }
    expect(restore).toHaveBeenCalledTimes(1);
    expect(remove).toHaveBeenCalledTimes(1);
  });

  it('keeps reaped entries informational without restore or delete controls', () => {
    const { fixture, buttons } = setup('reaped');
    expect(buttons).toHaveLength(0);
    expect(fixture.nativeElement.textContent).toContain('Removed from disk');
  });
});
