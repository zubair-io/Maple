import { TestBed } from '@angular/core/testing';
import type { ComponentFixture } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';

import { MuiIconComponent } from './mui-icon.component';

function render(): ComponentFixture<MuiIconComponent> {
  // Several tests call render() more than once per `it()` to compare two
  // independently-configured fixtures — TestBed refuses to reconfigure once
  // a prior render() has instantiated a component, so start fresh each time.
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({ imports: [MuiIconComponent] });
  const fixture = TestBed.createComponent(MuiIconComponent);
  fixture.componentRef.setInput('name', 'plus');
  fixture.detectChanges();
  return fixture;
}

describe('MuiIconComponent', () => {
  it('renders the wrapped MapleIcon svg with the resolved glyph', () => {
    const fixture = render();
    const svg = fixture.nativeElement.querySelector('svg');
    expect(svg).toBeTruthy();
    expect(svg.querySelector('path')).toBeTruthy();
  });

  it('maps each size step to its pixel value per icon.md (xs 14 / sm 16 / md 24 / lg 30 / xl 36)', () => {
    const expected: Record<string, string> = { xs: '14', sm: '16', md: '24', lg: '30', xl: '36' };
    for (const [size, px] of Object.entries(expected)) {
      const fixture = render();
      fixture.componentRef.setInput('size', size);
      fixture.detectChanges();
      const svg = fixture.nativeElement.querySelector('svg') as SVGSVGElement;
      expect(svg.getAttribute('width')).toBe(px);
      expect(svg.getAttribute('height')).toBe(px);
    }
  });

  it('defaults to currentColor and passes through an explicit color override', () => {
    const defaultFixture = render();
    const defaultSvg = defaultFixture.nativeElement.querySelector('svg') as SVGSVGElement;
    // jsdom (like real browsers) lower-cases the `currentColor` keyword when
    // serializing it back out of `style.color`.
    expect(defaultSvg.style.color).toBe('currentcolor');

    const overrideFixture = render();
    overrideFixture.componentRef.setInput('color', 'var(--color-star)');
    overrideFixture.detectChanges();
    const overrideSvg = overrideFixture.nativeElement.querySelector('svg') as SVGSVGElement;
    expect(overrideSvg.style.color).toBe('var(--color-star)');
  });

  it('hides decorative icons from assistive tech, and omits aria-hidden when marked meaningful', () => {
    // fixture.nativeElement IS the <mui-icon> host element (it's the root
    // component under test), so aria-hidden is read directly off it.
    const decorativeFixture = render();
    expect((decorativeFixture.nativeElement as HTMLElement).getAttribute('aria-hidden')).toBe(
      'true',
    );

    const meaningfulFixture = render();
    meaningfulFixture.componentRef.setInput('decorative', false);
    meaningfulFixture.detectChanges();
    expect((meaningfulFixture.nativeElement as HTMLElement).getAttribute('aria-hidden')).toBeNull();
  });
});
