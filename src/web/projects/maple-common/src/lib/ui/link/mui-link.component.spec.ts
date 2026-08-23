import { TestBed } from '@angular/core/testing';
import type { ComponentFixture } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';

import { MuiLinkComponent } from './mui-link.component';

function render(): ComponentFixture<MuiLinkComponent> {
  TestBed.configureTestingModule({ imports: [MuiLinkComponent] });
  const fixture = TestBed.createComponent(MuiLinkComponent);
  fixture.componentRef.setInput('href', '/photos/123');
  fixture.detectChanges();
  return fixture;
}

function anchor(fixture: ComponentFixture<MuiLinkComponent>): HTMLAnchorElement {
  return fixture.nativeElement.querySelector('a') as HTMLAnchorElement;
}

describe('MuiLinkComponent', () => {
  it('renders a plain internal anchor with no target/rel and no external icon', () => {
    const fixture = render();
    const a = anchor(fixture);
    expect(a.getAttribute('href')).toBe('/photos/123');
    expect(a.getAttribute('target')).toBeNull();
    expect(a.getAttribute('rel')).toBeNull();
    expect(fixture.nativeElement.querySelector('mui-icon')).toBeNull();
  });

  it('external links open in a new tab with noopener/noreferrer and show the affordance icon', () => {
    const fixture = render();
    fixture.componentRef.setInput('external', true);
    fixture.detectChanges();
    const a = anchor(fixture);
    expect(a.getAttribute('target')).toBe('_blank');
    expect(a.getAttribute('rel')).toBe('noopener noreferrer');
    expect(fixture.nativeElement.querySelector('mui-icon')).toBeTruthy();
  });

  it('disabled removes the href and marks aria-disabled', () => {
    const fixture = render();
    fixture.componentRef.setInput('disabled', true);
    fixture.detectChanges();
    const a = anchor(fixture);
    expect(a.getAttribute('href')).toBeNull();
    expect(a.getAttribute('aria-disabled')).toBe('true');
    expect(a.className).toContain('disabled');
  });
});
