import { TestBed } from '@angular/core/testing';
import type { ComponentFixture } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';

import { MuiValueHudComponent } from './mui-value-hud.component';

function render(): ComponentFixture<MuiValueHudComponent> {
  TestBed.configureTestingModule({ imports: [MuiValueHudComponent] });
  const fixture = TestBed.createComponent(MuiValueHudComponent);
  fixture.componentRef.setInput('label', 'Exposure');
  fixture.componentRef.setInput('value', '+0.3');
  fixture.detectChanges();
  return fixture;
}

describe('MuiValueHudComponent', () => {
  it('renders the eyebrow label and the large value', () => {
    const fixture = render();
    expect(fixture.nativeElement.querySelector('.label').textContent).toContain('Exposure');
    expect(fixture.nativeElement.querySelector('.value').textContent).toContain('+0.3');
  });

  it('shows a Progress track when progressPct is given', () => {
    const fixture = render();
    expect(fixture.nativeElement.querySelector('mui-progress')).toBeNull();
    fixture.componentRef.setInput('progressPct', 60);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('mui-progress')).toBeTruthy();
  });

  it('omits the track entirely for an unbounded value', () => {
    const fixture = render();
    fixture.componentRef.setInput('progressPct', null);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('mui-progress')).toBeNull();
  });
});
