import { TestBed } from '@angular/core/testing';
import type { ComponentFixture } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';

import { MuiInputComponent } from './mui-input.component';

function render(): ComponentFixture<MuiInputComponent> {
  TestBed.configureTestingModule({ imports: [MuiInputComponent] });
  const fixture = TestBed.createComponent(MuiInputComponent);
  fixture.detectChanges();
  return fixture;
}

function control(fixture: ComponentFixture<MuiInputComponent>): HTMLInputElement {
  return fixture.nativeElement.querySelector('.control') as HTMLInputElement;
}

describe('MuiInputComponent', () => {
  it('reflects the value input and updates the model on native input events', () => {
    const fixture = render();
    fixture.componentRef.setInput('value', 'hello');
    fixture.detectChanges();
    expect(control(fixture).value).toBe('hello');

    control(fixture).value = 'world';
    control(fixture).dispatchEvent(new Event('input'));
    fixture.detectChanges();
    expect(fixture.componentInstance.value()).toBe('world');
  });

  it('marks focused/filled state classes and emits committed on blur and Enter', () => {
    const fixture = render();
    let committedValues: string[] = [];
    fixture.componentInstance.committed.subscribe((v) => committedValues.push(v));

    control(fixture).dispatchEvent(new Event('focus'));
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.mui-input').className).toContain('is-focused');

    fixture.componentRef.setInput('value', 'abc');
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.mui-input').className).toContain('is-filled');

    control(fixture).dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    expect(committedValues).toEqual(['abc']);

    control(fixture).dispatchEvent(new Event('blur'));
    fixture.detectChanges();
    expect(committedValues).toEqual(['abc', 'abc']);
    expect(fixture.nativeElement.querySelector('.mui-input').className).not.toContain('is-focused');
  });

  it('shows the error state and helper text when `error` is set', () => {
    const fixture = render();
    fixture.componentRef.setInput('error', 'Required field');
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.mui-input').className).toContain('is-error');
    expect(fixture.nativeElement.querySelector('.helper')?.textContent).toBe('Required field');
    expect(control(fixture).getAttribute('aria-invalid')).toBe('true');
  });

  it('search variant shows a prefix icon and a clear affordance only once filled', () => {
    const fixture = render();
    fixture.componentRef.setInput('variant', 'search');
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.prefix')).toBeTruthy();
    expect(fixture.nativeElement.querySelector('.clear')).toBeNull();

    fixture.componentRef.setInput('value', 'raw');
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.clear')).toBeTruthy();

    (fixture.nativeElement.querySelector('.clear') as HTMLButtonElement).click();
    fixture.detectChanges();
    expect(fixture.componentInstance.value()).toBe('');
  });

  it('numeric variant steppers increment/decrement and clamp to min/max', () => {
    const fixture = render();
    fixture.componentRef.setInput('variant', 'numeric');
    fixture.componentRef.setInput('value', '5');
    fixture.componentRef.setInput('min', 0);
    fixture.componentRef.setInput('max', 6);
    fixture.componentRef.setInput('step', 1);
    fixture.detectChanges();

    const [decrement, increment] = Array.from(
      fixture.nativeElement.querySelectorAll('.stepper'),
    ) as HTMLButtonElement[];

    increment.click();
    fixture.detectChanges();
    expect(fixture.componentInstance.value()).toBe('6');

    increment.click();
    fixture.detectChanges();
    expect(fixture.componentInstance.value()).toBe('6');

    decrement.click();
    decrement.click();
    decrement.click();
    decrement.click();
    decrement.click();
    decrement.click();
    decrement.click();
    fixture.detectChanges();
    expect(fixture.componentInstance.value()).toBe('0');
  });

  it('renders type="password" when `masked` is set, and type="text" otherwise', () => {
    const fixture = render();
    expect(control(fixture).type).toBe('text');

    fixture.componentRef.setInput('masked', true);
    fixture.detectChanges();
    expect(control(fixture).type).toBe('password');
  });

  it('forwards `autocomplete` to the native control', () => {
    const fixture = render();
    expect(control(fixture).getAttribute('autocomplete')).toBeNull();

    fixture.componentRef.setInput('autocomplete', 'off');
    fixture.detectChanges();
    expect(control(fixture).getAttribute('autocomplete')).toBe('off');
  });

  it('disables the control and blocks steppers when `disabled` is set', () => {
    const fixture = render();
    fixture.componentRef.setInput('variant', 'numeric');
    fixture.componentRef.setInput('disabled', true);
    fixture.detectChanges();
    expect(control(fixture).disabled).toBe(true);
    expect((fixture.nativeElement.querySelector('.stepper') as HTMLButtonElement).disabled).toBe(
      true,
    );
  });
});
