import { TestBed } from '@angular/core/testing';
import type { ComponentFixture } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';

import { MuiSegmentedToggleComponent } from './mui-segmented-toggle.component';

const OPTIONS = [
  { value: 'grid', label: 'Grid' },
  { value: 'list', label: 'List' },
  { value: 'map', label: 'Map' },
];

function render(): ComponentFixture<MuiSegmentedToggleComponent> {
  TestBed.configureTestingModule({ imports: [MuiSegmentedToggleComponent] });
  const fixture = TestBed.createComponent(MuiSegmentedToggleComponent);
  fixture.componentRef.setInput('options', OPTIONS);
  fixture.componentRef.setInput('value', 'grid');
  fixture.detectChanges();
  return fixture;
}

function segments(fixture: ComponentFixture<MuiSegmentedToggleComponent>): HTMLButtonElement[] {
  return Array.from(fixture.nativeElement.querySelectorAll('.segment'));
}

describe('MuiSegmentedToggleComponent', () => {
  it('renders every option as a radio segment with the current one marked selected', () => {
    const fixture = render();
    const buttons = segments(fixture);
    expect(buttons).toHaveLength(3);
    expect(buttons[0].getAttribute('role')).toBe('radio');
    expect(buttons[0].getAttribute('aria-checked')).toBe('true');
    expect(buttons[1].getAttribute('aria-checked')).toBe('false');
  });

  it('clicking a segment updates the `value` model', () => {
    const fixture = render();

    segments(fixture)[1].click();
    fixture.detectChanges();
    expect(fixture.componentInstance.value()).toBe('list');
    expect(segments(fixture)[1].getAttribute('aria-checked')).toBe('true');
    expect(segments(fixture)[0].getAttribute('aria-checked')).toBe('false');
  });

  it('positions the sliding indicator at the selected index', () => {
    const fixture = render();
    const indicator = fixture.nativeElement.querySelector('.indicator') as HTMLElement;
    expect(indicator.style.transform).toBe('translateX(0%)');

    fixture.componentRef.setInput('value', 'map');
    fixture.detectChanges();
    expect(indicator.style.transform).toBe('translateX(200%)');
  });

  it('blocks selection changes while disabled', () => {
    const fixture = render();
    fixture.componentRef.setInput('disabled', true);
    fixture.detectChanges();
    segments(fixture)[1].click();
    fixture.detectChanges();
    expect(fixture.componentInstance.value()).toBe('grid');
    expect(segments(fixture)[0].disabled).toBe(true);
  });
});
