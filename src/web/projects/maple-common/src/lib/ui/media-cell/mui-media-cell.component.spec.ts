import { TestBed } from '@angular/core/testing';
import type { ComponentFixture } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';

import { MuiMediaCellComponent } from './mui-media-cell.component';

function render(): ComponentFixture<MuiMediaCellComponent> {
  TestBed.configureTestingModule({ imports: [MuiMediaCellComponent] });
  const fixture = TestBed.createComponent(MuiMediaCellComponent);
  fixture.componentRef.setInput('src', 'https://example.com/thumb.jpg');
  fixture.componentRef.setInput('alt', 'Ballet');
  fixture.componentRef.setInput('filename', 'DSC_0003.NEF');
  fixture.detectChanges();
  return fixture;
}

describe('MuiMediaCellComponent', () => {
  it('emits pressed on a thumbnail click, not on rename/rating interactions', () => {
    const fixture = render();
    let pressCount = 0;
    fixture.componentInstance.pressed.subscribe(() => pressCount++);

    (fixture.nativeElement.querySelector('.mui-media-cell') as HTMLElement).click();
    expect(pressCount).toBe(1);

    (fixture.nativeElement.querySelector('.meta') as HTMLElement).click();
    expect(pressCount).toBe(1); // stopPropagation keeps the meta row from re-triggering a press
  });

  it('shows the selection outline class when selected', () => {
    const fixture = render();
    expect(fixture.nativeElement.querySelector('.mui-media-cell').className).not.toContain(
      'is-selected',
    );
    fixture.componentRef.setInput('selected', true);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.mui-media-cell').className).toContain(
      'is-selected',
    );
  });

  it('renders badges and forwards a rename to the renamed output', () => {
    const fixture = render();
    fixture.componentRef.setInput('badges', ['RAW']);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelectorAll('.badges mui-badge').length).toBe(1);

    const renamed: string[] = [];
    fixture.componentInstance.renamed.subscribe((name) => renamed.push(name));

    (fixture.nativeElement.querySelector('.display') as HTMLButtonElement).click();
    fixture.detectChanges();
    const control = fixture.nativeElement.querySelector('.control') as HTMLInputElement;
    control.value = 'ballet-003.nef';
    control.dispatchEvent(new Event('input'));
    control.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    fixture.detectChanges();

    expect(renamed).toEqual(['ballet-003.nef']);
    expect(fixture.componentInstance.filename()).toBe('ballet-003.nef');
  });

  it('Enter/Space on the cell also emits pressed', () => {
    const fixture = render();
    let pressCount = 0;
    fixture.componentInstance.pressed.subscribe(() => pressCount++);
    const cell = fixture.nativeElement.querySelector('.mui-media-cell') as HTMLElement;
    cell.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    expect(pressCount).toBe(1);
  });
});
