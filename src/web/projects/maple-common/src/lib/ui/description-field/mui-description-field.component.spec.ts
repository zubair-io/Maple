import { TestBed } from '@angular/core/testing';
import type { ComponentFixture } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';

import { MuiDescriptionFieldComponent } from './mui-description-field.component';

function render(): ComponentFixture<MuiDescriptionFieldComponent> {
  TestBed.configureTestingModule({ imports: [MuiDescriptionFieldComponent] });
  const fixture = TestBed.createComponent(MuiDescriptionFieldComponent);
  fixture.componentRef.setInput('value', 'A dancer stretching outdoors.');
  fixture.detectChanges();
  return fixture;
}

describe('MuiDescriptionFieldComponent', () => {
  it('shows the description text and enters edit mode on click', () => {
    const fixture = render();
    expect(fixture.nativeElement.querySelector('.display').textContent).toContain(
      'A dancer stretching outdoors.',
    );
    (fixture.nativeElement.querySelector('.display') as HTMLButtonElement).click();
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.control')).toBeTruthy();
  });

  it('commits an edited value on Enter and emits committed', () => {
    const fixture = render();
    const committed: string[] = [];
    fixture.componentInstance.committed.subscribe((v) => committed.push(v));

    (fixture.nativeElement.querySelector('.display') as HTMLButtonElement).click();
    fixture.detectChanges();
    const control = fixture.nativeElement.querySelector('.control') as HTMLInputElement;
    control.value = 'A dancer mid-leap.';
    control.dispatchEvent(new Event('input'));
    control.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    fixture.detectChanges();

    expect(committed).toEqual(['A dancer mid-leap.']);
    expect(fixture.componentInstance.value()).toBe('A dancer mid-leap.');
    expect(fixture.nativeElement.querySelector('.control')).toBeNull();
  });

  it('Escape cancels editing without committing', () => {
    const fixture = render();
    const committed: string[] = [];
    fixture.componentInstance.committed.subscribe((v) => committed.push(v));

    (fixture.nativeElement.querySelector('.display') as HTMLButtonElement).click();
    fixture.detectChanges();
    const control = fixture.nativeElement.querySelector('.control') as HTMLInputElement;
    control.value = 'Discarded edit';
    control.dispatchEvent(new Event('input'));
    control.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    fixture.detectChanges();

    expect(committed).toEqual([]);
    expect(fixture.componentInstance.value()).toBe('A dancer stretching outdoors.');
  });

  it('emits regenerate on click and disables the button while regenerating', () => {
    const fixture = render();
    let regenerateCount = 0;
    fixture.componentInstance.regenerate.subscribe(() => regenerateCount++);

    (fixture.nativeElement.querySelector('.regenerate .mui-button') as HTMLButtonElement).click();
    expect(regenerateCount).toBe(1);

    fixture.componentRef.setInput('regenerating', true);
    fixture.detectChanges();
    expect(
      (fixture.nativeElement.querySelector('.regenerate .mui-button') as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });
});
