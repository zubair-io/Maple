import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import type { ComponentFixture } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';

import { MuiTextComponent } from './mui-text.component';
import type { MuiTextColor, MuiTextVariant } from './mui-text.component';

function render(): ComponentFixture<MuiTextComponent> {
  // Several tests call render() more than once per `it()` (once per loop
  // iteration) — TestBed refuses to reconfigure once a prior render() has
  // instantiated a component, so start fresh each time.
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({ imports: [MuiTextComponent] });
  const fixture = TestBed.createComponent(MuiTextComponent);
  fixture.detectChanges();
  return fixture;
}

function span(fixture: ComponentFixture<MuiTextComponent>): HTMLElement {
  return fixture.nativeElement.querySelector('.mui-text') as HTMLElement;
}

describe('MuiTextComponent', () => {
  it('reflects every type-scale variant as a rendered class', () => {
    const variants: MuiTextVariant[] = [
      'source-title',
      'sheet-title',
      'row-label',
      'body',
      'tool-label',
      'chip-label',
      'eyebrow',
      'value-chip',
      'filename',
    ];
    for (const variant of variants) {
      const fixture = render();
      fixture.componentRef.setInput('variant', variant);
      fixture.detectChanges();
      expect(span(fixture).className).toContain(`variant-${variant}`);
    }
  });

  it('reflects every color role as a rendered class', () => {
    const colors: MuiTextColor[] = ['main', 'muted', 'on-accent', 'success', 'warning', 'error'];
    for (const color of colors) {
      const fixture = render();
      fixture.componentRef.setInput('color', color);
      fixture.detectChanges();
      expect(span(fixture).className).toContain(`color-${color}`);
    }
  });

  it('applies the truncate class', () => {
    const fixture = render();
    fixture.componentRef.setInput('truncate', true);
    fixture.detectChanges();
    expect(span(fixture).className).toContain('truncate');
  });

  it('applies the line-clamp class and the -webkit-line-clamp style, independent of truncate', () => {
    const fixture = render();
    fixture.componentRef.setInput('lineClamp', 3);
    fixture.detectChanges();
    expect(span(fixture).className).toContain('line-clamp');
    expect(span(fixture).style.getPropertyValue('-webkit-line-clamp')).toBe('3');
  });

  it('switches to a block element when block is set', () => {
    const fixture = render();
    fixture.componentRef.setInput('block', true);
    fixture.detectChanges();
    expect(span(fixture).className).toContain('block');
  });
});

@Component({
  selector: 'test-host',
  standalone: true,
  imports: [MuiTextComponent],
  template: `<mui-text>Hello world</mui-text>`,
})
class ProjectedContentHostComponent {}

describe('MuiTextComponent — content projection', () => {
  it('renders the projected content', () => {
    TestBed.configureTestingModule({ imports: [ProjectedContentHostComponent] });
    const fixture = TestBed.createComponent(ProjectedContentHostComponent);
    fixture.detectChanges();
    expect(
      (fixture.nativeElement as HTMLElement).querySelector('.mui-text')?.textContent?.trim(),
    ).toBe('Hello world');
  });
});
