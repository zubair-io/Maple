import { TestBed } from '@angular/core/testing';
import type { ComponentFixture } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';

import { MuiStatComponent } from './mui-stat.component';

function render(): ComponentFixture<MuiStatComponent> {
  TestBed.configureTestingModule({ imports: [MuiStatComponent] });
  const fixture = TestBed.createComponent(MuiStatComponent);
  fixture.componentRef.setInput('value', 128);
  fixture.componentRef.setInput('label', 'Photos');
  fixture.detectChanges();
  return fixture;
}

describe('MuiStatComponent', () => {
  it('renders the value and label', () => {
    const fixture = render();
    expect(fixture.nativeElement.querySelector('.value')?.textContent).toBe('128');
    expect(fixture.nativeElement.querySelector('.label')?.textContent).toBe('Photos');
  });

  it('reflects the size input as a rendered class', () => {
    const fixture = render();
    expect((fixture.nativeElement.querySelector('.mui-stat') as HTMLElement).className).toContain(
      'size-lg',
    );
    fixture.componentRef.setInput('size', 'sm');
    fixture.detectChanges();
    expect((fixture.nativeElement.querySelector('.mui-stat') as HTMLElement).className).toContain(
      'size-sm',
    );
  });

  it('omits the delta row entirely when delta is not provided', () => {
    const fixture = render();
    expect(fixture.nativeElement.querySelector('.delta')).toBeNull();
  });

  it('renders delta with a trend glyph and trend-specific class for up/down/flat', () => {
    const fixture = render();
    fixture.componentRef.setInput('delta', '+12');
    fixture.componentRef.setInput('trend', 'up');
    fixture.detectChanges();
    let delta = fixture.nativeElement.querySelector('.delta') as HTMLElement;
    expect(delta.className).toContain('trend-up');
    expect(delta.querySelector('.trend-glyph')?.textContent).toBe('▲');
    expect(delta.textContent).toContain('+12');

    fixture.componentRef.setInput('trend', 'down');
    fixture.detectChanges();
    delta = fixture.nativeElement.querySelector('.delta') as HTMLElement;
    expect(delta.className).toContain('trend-down');
    expect(delta.querySelector('.trend-glyph')?.textContent).toBe('▼');

    fixture.componentRef.setInput('trend', 'flat');
    fixture.detectChanges();
    delta = fixture.nativeElement.querySelector('.delta') as HTMLElement;
    expect(delta.className).toContain('trend-flat');
    expect(delta.querySelector('.trend-glyph')?.textContent).toBe('–');
  });

  it('shows the delta without a glyph when no trend direction is given', () => {
    const fixture = render();
    fixture.componentRef.setInput('delta', '0');
    fixture.detectChanges();
    const delta = fixture.nativeElement.querySelector('.delta') as HTMLElement;
    expect(delta.querySelector('.trend-glyph')).toBeNull();
    expect(delta.textContent?.trim()).toBe('0');
  });
});
