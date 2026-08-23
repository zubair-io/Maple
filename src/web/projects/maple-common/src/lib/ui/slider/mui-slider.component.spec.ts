import { TestBed } from '@angular/core/testing';
import type { ComponentFixture } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';

import { MuiSliderComponent } from './mui-slider.component';

function render(): ComponentFixture<MuiSliderComponent> {
  TestBed.configureTestingModule({ imports: [MuiSliderComponent] });
  const fixture = TestBed.createComponent(MuiSliderComponent);
  fixture.componentRef.setInput('label', 'Exposure');
  fixture.componentRef.setInput('value', 0.3);
  fixture.componentRef.setInput('min', -2);
  fixture.componentRef.setInput('max', 2);
  fixture.componentRef.setInput('step', 0.1);
  fixture.detectChanges();
  return fixture;
}

function track(fixture: ComponentFixture<MuiSliderComponent>): HTMLInputElement {
  return fixture.nativeElement.querySelector('.track') as HTMLInputElement;
}

describe('MuiSliderComponent', () => {
  it('renders the label and a signed, formatted readout', () => {
    const fixture = render();
    expect(fixture.nativeElement.querySelector('.label').textContent).toContain('Exposure');
    expect(fixture.nativeElement.querySelector('.readout').textContent.trim()).toBe('+0.3');
  });

  it('is a native range input reflecting min/max/step/value', () => {
    const fixture = render();
    const el = track(fixture);
    expect(el.type).toBe('range');
    expect(el.min).toBe('-2');
    expect(el.max).toBe('2');
    expect(el.step).toBe('0.1');
    expect(el.value).toBe('0.3');
  });

  it('updates the value model on native input events (covers keyboard/arrow operation)', () => {
    const fixture = render();
    const el = track(fixture);
    el.value = '1.1';
    el.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    expect(fixture.componentInstance.value()).toBe(1.1);
    expect(fixture.nativeElement.querySelector('.readout').textContent.trim()).toBe('+1.1');
  });

  it('disables the control and dims the widget when disabled', () => {
    const fixture = render();
    fixture.componentRef.setInput('disabled', true);
    fixture.detectChanges();
    expect(track(fixture).disabled).toBe(true);
    expect(fixture.nativeElement.querySelector('.mui-slider').className).toContain('is-disabled');
  });
});
