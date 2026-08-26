import { TestBed } from '@angular/core/testing';
import type { ComponentFixture } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';

import { MuiCheckboxComponent } from './mui-checkbox.component';

function render(): ComponentFixture<MuiCheckboxComponent> {
  TestBed.configureTestingModule({ imports: [MuiCheckboxComponent] });
  const fixture = TestBed.createComponent(MuiCheckboxComponent);
  fixture.detectChanges();
  return fixture;
}

function box(fixture: ComponentFixture<MuiCheckboxComponent>): HTMLInputElement {
  return fixture.nativeElement.querySelector('.box') as HTMLInputElement;
}

describe('MuiCheckboxComponent', () => {
  it('uses a native checkbox role and reflects the unchecked/checked states', () => {
    const fixture = render();
    expect(box(fixture).type).toBe('checkbox');
    expect(box(fixture).checked).toBe(false);

    fixture.componentRef.setInput('checked', true);
    fixture.detectChanges();
    expect(box(fixture).checked).toBe(true);
    expect(fixture.nativeElement.querySelector('.mark').className).toContain('is-checked');
    expect(fixture.nativeElement.querySelector('.check')).toBeTruthy();
  });

  it('renders the indeterminate state via the native property, not just a visual dash', () => {
    const fixture = render();
    fixture.componentRef.setInput('checked', 'indeterminate');
    fixture.detectChanges();
    expect(box(fixture).indeterminate).toBe(true);
    expect(box(fixture).checked).toBe(false);
    expect(fixture.nativeElement.querySelector('.dash')).toBeTruthy();
  });

  it('emits checkedChange from native change events', () => {
    const fixture = render();
    let emitted: boolean[] = [];
    fixture.componentInstance.checkedChange.subscribe((v) => emitted.push(v));

    box(fixture).checked = true;
    box(fixture).dispatchEvent(new Event('change'));
    expect(emitted).toEqual([true]);
  });

  it('renders the label text when provided, and falls back to ariaLabel when not', () => {
    const fixture = render();
    fixture.componentRef.setInput('label', 'Select all');
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.label')?.textContent).toBe('Select all');
    expect(box(fixture).getAttribute('aria-label')).toBeNull();

    fixture.componentRef.setInput('label', null);
    fixture.componentRef.setInput('ariaLabel', 'Select row');
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.label')).toBeNull();
    expect(box(fixture).getAttribute('aria-label')).toBe('Select row');
  });

  it("forwards `inputId` to the native control's id, and omits the attribute when unset", () => {
    const fixture = render();
    expect(box(fixture).getAttribute('id')).toBeNull();

    fixture.componentRef.setInput('inputId', 'cloudflare-enabled');
    fixture.detectChanges();
    expect(box(fixture).getAttribute('id')).toBe('cloudflare-enabled');
  });

  it('disables the native input when `disabled` is set', () => {
    const fixture = render();
    fixture.componentRef.setInput('disabled', true);
    fixture.detectChanges();
    expect(box(fixture).disabled).toBe(true);
  });
});
