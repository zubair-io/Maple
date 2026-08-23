import { TestBed } from '@angular/core/testing';
import type { ComponentFixture } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';

import { MuiValueChipComponent } from './mui-value-chip.component';

function render(): ComponentFixture<MuiValueChipComponent> {
  TestBed.configureTestingModule({ imports: [MuiValueChipComponent] });
  const fixture = TestBed.createComponent(MuiValueChipComponent);
  fixture.componentRef.setInput('label', 'Exposure');
  fixture.componentRef.setInput('value', '+0.3');
  fixture.detectChanges();
  return fixture;
}

describe('MuiValueChipComponent', () => {
  it('renders the label as Text and the value as a Badge', () => {
    const fixture = render();
    expect(fixture.nativeElement.querySelector('mui-text').textContent).toContain('Exposure');
    expect(fixture.nativeElement.querySelector('mui-badge').textContent).toContain('+0.3');
  });

  it('updates when the value input changes', () => {
    const fixture = render();
    fixture.componentRef.setInput('value', '+0.7');
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('mui-badge').textContent).toContain('+0.7');
  });
});
