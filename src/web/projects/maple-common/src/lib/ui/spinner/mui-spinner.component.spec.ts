import { TestBed } from '@angular/core/testing';
import type { ComponentFixture } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';

import { MuiSpinnerComponent } from './mui-spinner.component';

function render(): ComponentFixture<MuiSpinnerComponent> {
  TestBed.configureTestingModule({ imports: [MuiSpinnerComponent] });
  const fixture = TestBed.createComponent(MuiSpinnerComponent);
  fixture.detectChanges();
  return fixture;
}

describe('MuiSpinnerComponent', () => {
  it('exposes a status role with an accessible label', () => {
    const fixture = render();
    const root = fixture.nativeElement.querySelector('.mui-spinner') as HTMLElement;
    expect(root.getAttribute('role')).toBe('status');
    expect(root.getAttribute('aria-label')).toBe('Loading');
  });

  it('reflects size and placement inputs as classes', () => {
    const fixture = render();
    fixture.componentRef.setInput('size', 'sm');
    fixture.componentRef.setInput('placement', 'centered');
    fixture.detectChanges();
    const root = fixture.nativeElement.querySelector('.mui-spinner') as HTMLElement;
    expect(root.className).toContain('size-sm');
    expect(root.className).toContain('placement-centered');
  });

  it('applies delayMs as a CSS animation-delay so a fast load never flashes it', () => {
    const fixture = render();
    fixture.componentRef.setInput('delayMs', 300);
    fixture.detectChanges();
    const root = fixture.nativeElement.querySelector('.mui-spinner') as HTMLElement;
    expect(root.style.animationDelay).toBe('300ms');
  });

  it('defaults the animation delay to 0ms (shows immediately)', () => {
    const fixture = render();
    const root = fixture.nativeElement.querySelector('.mui-spinner') as HTMLElement;
    expect(root.style.animationDelay).toBe('0ms');
  });
});
