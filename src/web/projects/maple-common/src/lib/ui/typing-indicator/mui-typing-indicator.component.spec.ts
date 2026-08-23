import { TestBed } from '@angular/core/testing';
import type { ComponentFixture } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';

import { MuiTypingIndicatorComponent } from './mui-typing-indicator.component';

function render(): ComponentFixture<MuiTypingIndicatorComponent> {
  TestBed.configureTestingModule({ imports: [MuiTypingIndicatorComponent] });
  const fixture = TestBed.createComponent(MuiTypingIndicatorComponent);
  fixture.componentRef.setInput('name', 'Sam');
  fixture.detectChanges();
  return fixture;
}

describe('MuiTypingIndicatorComponent', () => {
  it('renders the avatar and "is typing" text for the given name', () => {
    const fixture = render();
    expect(fixture.nativeElement.querySelector('mui-avatar')).toBeTruthy();
    expect(fixture.nativeElement.textContent).toContain('Sam is typing');
  });

  it('exposes a polite live-region role for assistive tech', () => {
    const fixture = render();
    expect(fixture.nativeElement.getAttribute('role')).toBe('status');
    expect(fixture.nativeElement.getAttribute('aria-live')).toBe('polite');
  });

  it('renders three animated dots', () => {
    const fixture = render();
    expect(fixture.nativeElement.querySelectorAll('.dot').length).toBe(3);
  });
});
