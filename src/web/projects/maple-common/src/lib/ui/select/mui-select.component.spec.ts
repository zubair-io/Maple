import { TestBed } from '@angular/core/testing';
import { describe, expect, it, vi } from 'vitest';
import { MuiSelectComponent } from './mui-select.component';

describe('MuiSelect native semantics', () => {
  it('exposes the selected value and accessible name; emits only available choices', () => {
    const fixture = TestBed.createComponent(MuiSelectComponent);
    fixture.componentRef.setInput('value', 'daylight');
    fixture.componentRef.setInput('ariaLabel', 'White balance');
    fixture.componentRef.setInput('options', [
      { value: 'daylight', label: 'Daylight' },
      { value: 'shade', label: 'Shade' },
      { value: 'auto', label: 'Auto', disabled: true },
    ]);
    fixture.detectChanges();
    const select: HTMLSelectElement = fixture.nativeElement.querySelector('select');
    expect(select.getAttribute('aria-label')).toBe('White balance');
    expect(select.value).toBe('daylight');
    expect(select.options[2].disabled).toBe(true);
    const change = vi.fn();
    fixture.componentInstance.valueChange.subscribe(change);
    select.value = 'shade';
    select.dispatchEvent(new Event('change'));
    expect(change).toHaveBeenCalledWith('shade');
    // A parent may reject the choice or await an analysis. Until it accepts
    // a new input value, the DOM must continue to reflect the current model.
    fixture.detectChanges();
    expect(select.value).toBe('daylight');
    fixture.componentRef.setInput('value', 'shade');
    fixture.detectChanges();
    expect(select.value).toBe('shade');
    change.mockClear();
    fixture.componentInstance.select('auto');
    fixture.componentInstance.select('missing');
    expect(change).not.toHaveBeenCalled();
    fixture.componentRef.setInput('disabled', true);
    fixture.detectChanges();
    expect(select.disabled).toBe(true);
    fixture.componentInstance.select('shade');
    expect(change).not.toHaveBeenCalled();
  });
});
