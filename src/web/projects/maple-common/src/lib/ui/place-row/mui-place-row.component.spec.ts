import { TestBed } from '@angular/core/testing';
import type { ComponentFixture } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';

import { MuiPlaceRowComponent } from './mui-place-row.component';

function render(): ComponentFixture<MuiPlaceRowComponent> {
  TestBed.configureTestingModule({ imports: [MuiPlaceRowComponent] });
  const fixture = TestBed.createComponent(MuiPlaceRowComponent);
  fixture.componentRef.setInput('place', 'Ridgewood, NJ');
  fixture.detectChanges();
  return fixture;
}

describe('MuiPlaceRowComponent', () => {
  it('renders the place name and edits on click', () => {
    const fixture = render();
    expect(fixture.nativeElement.textContent).toContain('Ridgewood, NJ');
    (fixture.nativeElement.querySelector('.display') as HTMLButtonElement).click();
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.control')).toBeTruthy();
  });

  it('commits an override on Enter', () => {
    const fixture = render();
    const committed: string[] = [];
    fixture.componentInstance.committed.subscribe((v) => committed.push(v));

    (fixture.nativeElement.querySelector('.display') as HTMLButtonElement).click();
    fixture.detectChanges();
    const control = fixture.nativeElement.querySelector('.control') as HTMLInputElement;
    control.value = 'Brooklyn, NY';
    control.dispatchEvent(new Event('input'));
    control.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    fixture.detectChanges();

    expect(committed).toEqual(['Brooklyn, NY']);
    expect(fixture.componentInstance.place()).toBe('Brooklyn, NY');
  });

  it('shows a clear button only when overridden, and emits cleared', () => {
    const fixture = render();
    expect(fixture.nativeElement.querySelector('mui-button')).toBeNull();

    fixture.componentRef.setInput('overridden', true);
    fixture.detectChanges();
    const clearButton = fixture.nativeElement.querySelector(
      'button[aria-label="Clear override"]',
    ) as HTMLButtonElement;
    expect(clearButton).toBeTruthy();

    let clearedCount = 0;
    fixture.componentInstance.cleared.subscribe(() => clearedCount++);
    clearButton.click();
    expect(clearedCount).toBe(1);
  });
});
