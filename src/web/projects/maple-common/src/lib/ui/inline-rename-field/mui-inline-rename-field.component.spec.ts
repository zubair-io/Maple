import { TestBed } from '@angular/core/testing';
import type { ComponentFixture } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';

import { MuiInlineRenameFieldComponent } from './mui-inline-rename-field.component';

function render(): ComponentFixture<MuiInlineRenameFieldComponent> {
  TestBed.configureTestingModule({ imports: [MuiInlineRenameFieldComponent] });
  const fixture = TestBed.createComponent(MuiInlineRenameFieldComponent);
  fixture.componentRef.setInput('value', 'test_0003');
  fixture.detectChanges();
  return fixture;
}

describe('MuiInlineRenameFieldComponent', () => {
  it('renders the current name as static text until activated', () => {
    const fixture = render();
    expect(fixture.nativeElement.querySelector('.display')).toBeTruthy();
    expect(fixture.nativeElement.querySelector('.control')).toBeNull();
    expect(fixture.nativeElement.textContent).toContain('test_0003');
  });

  it('clicking the display swaps to an editable input pre-filled with the value', () => {
    const fixture = render();
    (fixture.nativeElement.querySelector('.display') as HTMLButtonElement).click();
    fixture.detectChanges();
    const control = fixture.nativeElement.querySelector('.control') as HTMLInputElement;
    expect(control).toBeTruthy();
    expect(control.value).toBe('test_0003');
  });

  it('Enter commits the new name and emits renamed', () => {
    const fixture = render();
    const renamed: string[] = [];
    fixture.componentInstance.renamed.subscribe((v) => renamed.push(v));

    (fixture.nativeElement.querySelector('.display') as HTMLButtonElement).click();
    fixture.detectChanges();
    const control = fixture.nativeElement.querySelector('.control') as HTMLInputElement;
    control.value = 'roll_02';
    control.dispatchEvent(new Event('input'));
    control.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    fixture.detectChanges();

    expect(renamed).toEqual(['roll_02']);
    expect(fixture.componentInstance.value()).toBe('roll_02');
    expect(fixture.nativeElement.querySelector('.control')).toBeNull();
  });

  it('Escape cancels the edit without emitting renamed', () => {
    const fixture = render();
    const renamed: string[] = [];
    fixture.componentInstance.renamed.subscribe((v) => renamed.push(v));

    (fixture.nativeElement.querySelector('.display') as HTMLButtonElement).click();
    fixture.detectChanges();
    const control = fixture.nativeElement.querySelector('.control') as HTMLInputElement;
    control.value = 'abandoned';
    control.dispatchEvent(new Event('input'));
    control.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    fixture.detectChanges();

    expect(renamed).toEqual([]);
    expect(fixture.componentInstance.value()).toBe('test_0003');
    expect(fixture.nativeElement.textContent).toContain('test_0003');
  });

  it('an empty commit is discarded and the original value is kept', () => {
    const fixture = render();
    (fixture.nativeElement.querySelector('.display') as HTMLButtonElement).click();
    fixture.detectChanges();
    const control = fixture.nativeElement.querySelector('.control') as HTMLInputElement;
    control.value = '   ';
    control.dispatchEvent(new Event('input'));
    control.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    fixture.detectChanges();

    expect(fixture.componentInstance.value()).toBe('test_0003');
  });

  it('does not enter edit mode when disabled', () => {
    const fixture = render();
    fixture.componentRef.setInput('disabled', true);
    fixture.detectChanges();
    (fixture.nativeElement.querySelector('.display') as HTMLButtonElement).click();
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.control')).toBeNull();
  });
});
