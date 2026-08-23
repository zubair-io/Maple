import { TestBed } from '@angular/core/testing';
import type { ComponentFixture } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';

import { MuiKeywordRowComponent } from './mui-keyword-row.component';

function render(): ComponentFixture<MuiKeywordRowComponent> {
  TestBed.configureTestingModule({ imports: [MuiKeywordRowComponent] });
  const fixture = TestBed.createComponent(MuiKeywordRowComponent);
  fixture.componentRef.setInput('keywords', [
    { id: 'family', label: 'family' },
    { id: '2026', label: '2026' },
  ]);
  fixture.detectChanges();
  return fixture;
}

describe('MuiKeywordRowComponent', () => {
  it('renders removable chips for each keyword', () => {
    const fixture = render();
    expect(fixture.nativeElement.querySelectorAll('.chip').length).toBe(2);
  });

  it('emits removed with the keyword id on remove click', () => {
    const fixture = render();
    const removed: string[] = [];
    fixture.componentInstance.removed.subscribe((id) => removed.push(id));
    (fixture.nativeElement.querySelectorAll('.remove')[0] as HTMLButtonElement).click();
    expect(removed).toEqual(['family']);
  });

  it('emits added and clears the draft on Enter in the add input', () => {
    const fixture = render();
    const added: string[] = [];
    fixture.componentInstance.added.subscribe((label) => added.push(label));

    const addControl = fixture.nativeElement.querySelector('.add .control') as HTMLInputElement;
    addControl.value = 'dance';
    addControl.dispatchEvent(new Event('input'));
    addControl.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    fixture.detectChanges();

    expect(added).toEqual(['dance']);
    expect(fixture.componentInstance.draft()).toBe('');
  });

  it('renders no chip row when there are no keywords yet', () => {
    const fixture = render();
    fixture.componentRef.setInput('keywords', []);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('mui-chip-row')).toBeNull();
    expect(fixture.nativeElement.querySelector('.add')).toBeTruthy();
  });
});
