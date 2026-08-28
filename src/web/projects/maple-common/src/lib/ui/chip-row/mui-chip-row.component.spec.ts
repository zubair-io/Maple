import { TestBed } from '@angular/core/testing';
import type { ComponentFixture } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';

import { MuiChipRowComponent } from './mui-chip-row.component';

const CHIPS = [
  { id: 'all', label: 'All' },
  { id: 'photos', label: 'Photos' },
  { id: 'videos', label: 'Videos' },
];

function render(mode: 'select' | 'removable' | 'editable' = 'select') {
  TestBed.configureTestingModule({ imports: [MuiChipRowComponent] });
  const fixture = TestBed.createComponent(MuiChipRowComponent);
  fixture.componentRef.setInput('chips', CHIPS);
  fixture.componentRef.setInput('mode', mode);
  fixture.detectChanges();
  return fixture;
}

describe('MuiChipRowComponent', () => {
  it('select mode: clicking a chip selects it and marks aria-pressed', () => {
    const fixture = render('select');
    const chips = fixture.nativeElement.querySelectorAll('.chip');
    expect(chips.length).toBe(3);

    (chips[1] as HTMLButtonElement).click();
    fixture.detectChanges();
    expect(fixture.componentInstance.selectedId()).toBe('photos');
    expect(chips[1].getAttribute('aria-pressed')).toBe('true');
    expect(chips[0].getAttribute('aria-pressed')).toBe('false');
  });

  it('removable mode: clicking remove emits the chip id, not select', () => {
    const fixture = render('removable');
    const removed: string[] = [];
    fixture.componentInstance.removed.subscribe((id) => removed.push(id));

    const removeButtons = fixture.nativeElement.querySelectorAll('.remove');
    expect(removeButtons.length).toBe(3);
    (removeButtons[1] as HTMLButtonElement).click();
    expect(removed).toEqual(['photos']);
  });

  it('editable mode: shows a trailing add input; Enter emits added and clears the draft', () => {
    const fixture = render('editable');
    const added: string[] = [];
    fixture.componentInstance.added.subscribe((label) => added.push(label));

    const addControl = fixture.nativeElement.querySelector('.add .control') as HTMLInputElement;
    expect(addControl).toBeTruthy();
    addControl.value = 'Documents';
    addControl.dispatchEvent(new Event('input'));
    addControl.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    fixture.detectChanges();

    expect(added).toEqual(['Documents']);
    expect(fixture.componentInstance.draft()).toBe('');
  });

  it('select mode: a disabled chip cannot be selected and carries no aria-pressed toggle', () => {
    const fixture = render('select');
    fixture.componentRef.setInput('chips', [
      ...CHIPS,
      { id: 'locked', label: 'Locked', disabled: true },
    ]);
    fixture.detectChanges();
    const chips = fixture.nativeElement.querySelectorAll('.chip') as NodeListOf<HTMLButtonElement>;
    const locked = chips[3];
    expect(locked.disabled).toBe(true);

    locked.click();
    fixture.detectChanges();
    expect(fixture.componentInstance.selectedId()).toBeNull();
  });

  it('renders a modified dot only for chips flagged modified', () => {
    const fixture = render('select');
    fixture.componentRef.setInput('chips', [
      { id: 'all', label: 'All', modified: true },
      { id: 'photos', label: 'Photos' },
    ]);
    fixture.detectChanges();
    const chips = fixture.nativeElement.querySelectorAll('.chip');
    expect(chips[0].querySelector('.modified-dot')).not.toBeNull();
    expect(chips[1].querySelector('.modified-dot')).toBeNull();
  });

  it('passes testId through as the chip’s own data-testid', () => {
    const fixture = render('select');
    fixture.componentRef.setInput('chips', [{ id: 'all', label: 'All', testId: 'chip-all' }]);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('[data-testid="chip-all"]')).not.toBeNull();
  });

  it('ignores an empty/whitespace-only add commit', () => {
    const fixture = render('editable');
    const added: string[] = [];
    fixture.componentInstance.added.subscribe((label) => added.push(label));
    const addControl = fixture.nativeElement.querySelector('.add .control') as HTMLInputElement;
    addControl.value = '   ';
    addControl.dispatchEvent(new Event('input'));
    addControl.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    expect(added).toEqual([]);
  });
});
