import { TestBed } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';

import {
  MuiLabelValueGridComponent,
  type MuiLabelValueRow,
} from './mui-label-value-grid.component';

const ROWS: readonly MuiLabelValueRow[] = [
  { label: 'Camera', value: 'Sony A7IV' },
  { label: 'ISO', value: '400' },
];

describe('MuiLabelValueGridComponent', () => {
  it('renders a label and value cell for every row, in order', () => {
    const fixture = TestBed.createComponent(MuiLabelValueGridComponent);
    fixture.componentRef.setInput('rows', ROWS);
    fixture.detectChanges();

    const cells = fixture.nativeElement.querySelectorAll('mui-text');
    expect(cells.length).toBe(4);
    expect(cells[0].textContent.trim()).toBe('Camera');
    expect(cells[1].textContent.trim()).toBe('Sony A7IV');
    expect(cells[2].textContent.trim()).toBe('ISO');
    expect(cells[3].textContent.trim()).toBe('400');
  });

  it('renders nothing for an empty row set', () => {
    const fixture = TestBed.createComponent(MuiLabelValueGridComponent);
    fixture.componentRef.setInput('rows', []);
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelectorAll('mui-text').length).toBe(0);
  });
});
