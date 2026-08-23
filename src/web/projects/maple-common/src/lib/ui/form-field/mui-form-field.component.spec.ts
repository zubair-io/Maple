import { TestBed } from '@angular/core/testing';
import type { ComponentFixture } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';

import { MuiFormFieldComponent } from './mui-form-field.component';

function render(): ComponentFixture<MuiFormFieldComponent> {
  TestBed.configureTestingModule({ imports: [MuiFormFieldComponent] });
  const fixture = TestBed.createComponent(MuiFormFieldComponent);
  fixture.componentRef.setInput('label', 'Filename');
  fixture.detectChanges();
  return fixture;
}

function control(fixture: ComponentFixture<MuiFormFieldComponent>): HTMLInputElement {
  return fixture.nativeElement.querySelector('.control') as HTMLInputElement;
}

describe('MuiFormFieldComponent', () => {
  it('renders the label and forwards typing into the value model', () => {
    const fixture = render();
    expect(fixture.nativeElement.querySelector('.label').textContent).toContain('Filename');

    control(fixture).value = 'test_0003.NEF';
    control(fixture).dispatchEvent(new Event('input'));
    fixture.detectChanges();
    expect(fixture.componentInstance.value()).toBe('test_0003.NEF');
  });

  it('shows help text when there is no error, and hides it when there is', () => {
    const fixture = render();
    fixture.componentRef.setInput('help', 'Cannot contain / or \\');
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.help')?.textContent.trim()).toBe(
      'Cannot contain / or \\',
    );

    fixture.componentRef.setInput('error', 'Name is required');
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.help')).toBeNull();
    expect(fixture.nativeElement.querySelector('.mui-input').className).toContain('is-error');
  });

  it('emits committed on Enter, forwarded from the underlying input', () => {
    const fixture = render();
    const committed: string[] = [];
    fixture.componentInstance.committed.subscribe((v) => committed.push(v));

    control(fixture).value = 'roll_01';
    control(fixture).dispatchEvent(new Event('input'));
    control(fixture).dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    fixture.detectChanges();
    expect(committed).toEqual(['roll_01']);
  });

  it('marks required fields with an asterisk and disabled fields with a class', () => {
    const fixture = render();
    fixture.componentRef.setInput('required', true);
    fixture.componentRef.setInput('disabled', true);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.label').textContent).toContain('*');
    expect(fixture.nativeElement.querySelector('.mui-form-field').className).toContain(
      'is-disabled',
    );
    expect(control(fixture).disabled).toBe(true);
  });
});
