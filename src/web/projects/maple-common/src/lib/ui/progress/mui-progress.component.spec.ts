import { TestBed } from '@angular/core/testing';
import type { ComponentFixture } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';

import { MuiProgressComponent } from './mui-progress.component';

function render(): ComponentFixture<MuiProgressComponent> {
  TestBed.configureTestingModule({ imports: [MuiProgressComponent] });
  const fixture = TestBed.createComponent(MuiProgressComponent);
  fixture.detectChanges();
  return fixture;
}

describe('MuiProgressComponent', () => {
  it('renders a determinate bar with width matching the clamped value', () => {
    const fixture = render();
    fixture.componentRef.setInput('value', 60);
    fixture.detectChanges();
    const fill = fixture.nativeElement.querySelector('.bar-fill') as HTMLElement;
    expect(fill.style.width).toBe('60%');
    expect(fill.className).not.toContain('indeterminate');
    expect(fixture.nativeElement.querySelector('.mui-progress').getAttribute('aria-valuenow')).toBe(
      '60',
    );
  });

  it('clamps out-of-range values into 0..100', () => {
    const fixture = render();
    fixture.componentRef.setInput('value', 140);
    fixture.detectChanges();
    expect(fixture.componentInstance.clampedValue()).toBe(100);

    fixture.componentRef.setInput('value', -20);
    fixture.detectChanges();
    expect(fixture.componentInstance.clampedValue()).toBe(0);
  });

  it('renders an indeterminate bar with no aria-valuenow when value is null', () => {
    const fixture = render();
    const bar = fixture.nativeElement.querySelector('.mui-progress') as HTMLElement;
    expect(bar.getAttribute('aria-valuenow')).toBeNull();
    expect(fixture.nativeElement.querySelector('.bar-fill').className).toContain('indeterminate');
  });

  it('switches to the ring shape and computes stroke-dashoffset from the value', () => {
    const fixture = render();
    fixture.componentRef.setInput('shape', 'ring');
    fixture.componentRef.setInput('value', 50);
    fixture.detectChanges();
    const ringFill = fixture.nativeElement.querySelector('.ring-fill') as SVGCircleElement;
    const circumference = 2 * Math.PI * 16;
    expect(Number(ringFill.getAttribute('stroke-dashoffset'))).toBeCloseTo(circumference * 0.5, 5);
  });

  it('renders the optional label text', () => {
    const fixture = render();
    fixture.componentRef.setInput('label', '60%');
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.label')?.textContent).toBe('60%');
  });
});
