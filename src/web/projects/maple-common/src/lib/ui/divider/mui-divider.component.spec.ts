import { TestBed } from '@angular/core/testing';
import type { ComponentFixture } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';

import { MuiDividerComponent } from './mui-divider.component';

function render(): ComponentFixture<MuiDividerComponent> {
  TestBed.configureTestingModule({ imports: [MuiDividerComponent] });
  const fixture = TestBed.createComponent(MuiDividerComponent);
  fixture.detectChanges();
  return fixture;
}

function rule(fixture: ComponentFixture<MuiDividerComponent>): HTMLElement {
  return fixture.nativeElement.querySelector('.mui-divider') as HTMLElement;
}

describe('MuiDividerComponent', () => {
  it('defaults to a horizontal, default-emphasis rule', () => {
    const fixture = render();
    expect(rule(fixture).className).toContain('orientation-horizontal');
    expect(rule(fixture).className).toContain('emphasis-default');
  });

  it('reflects orientation and emphasis inputs as rendered classes', () => {
    const fixture = render();
    fixture.componentRef.setInput('orientation', 'vertical');
    fixture.componentRef.setInput('emphasis', 'high');
    fixture.detectChanges();
    expect(rule(fixture).className).toContain('orientation-vertical');
    expect(rule(fixture).className).toContain('emphasis-high');
  });

  it('is decorative — excluded from the accessibility tree', () => {
    const fixture = render();
    expect(rule(fixture).getAttribute('aria-hidden')).toBe('true');
  });
});
