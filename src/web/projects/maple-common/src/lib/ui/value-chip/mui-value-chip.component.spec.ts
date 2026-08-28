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

  it('renders multiple segments, each its own DOM node, in order', () => {
    TestBed.configureTestingModule({ imports: [MuiValueChipComponent] });
    const fixture = TestBed.createComponent(MuiValueChipComponent);
    fixture.componentRef.setInput('segments', [
      { text: 'DETAIL' },
      { text: 'SHARPEN' },
      { text: 'RADIUS', testId: 'editor-value-chip-subparam' },
    ]);
    fixture.componentRef.setInput('value', '1.0');
    fixture.detectChanges();

    const texts = Array.from(fixture.nativeElement.querySelectorAll('mui-text')) as HTMLElement[];
    expect(texts.map((t) => t.textContent?.trim())).toEqual(['DETAIL', 'SHARPEN', 'RADIUS']);

    const sub = fixture.nativeElement.querySelector(
      '[data-testid="editor-value-chip-subparam"]',
    ) as HTMLElement | null;
    expect(sub).not.toBeNull();
    expect(sub!.textContent?.trim()).toBe('RADIUS');
  });

  it('segments takes precedence over label when both are set', () => {
    TestBed.configureTestingModule({ imports: [MuiValueChipComponent] });
    const fixture = TestBed.createComponent(MuiValueChipComponent);
    fixture.componentRef.setInput('label', 'Ignored');
    fixture.componentRef.setInput('segments', [{ text: 'Group' }, { text: 'Tool' }]);
    fixture.componentRef.setInput('value', '5');
    fixture.detectChanges();

    const texts = Array.from(fixture.nativeElement.querySelectorAll('mui-text')) as HTMLElement[];
    expect(texts.map((t) => t.textContent?.trim())).toEqual(['Group', 'Tool']);
  });

  it('draws a divider between segments but not after the last one', () => {
    TestBed.configureTestingModule({ imports: [MuiValueChipComponent] });
    const fixture = TestBed.createComponent(MuiValueChipComponent);
    fixture.componentRef.setInput('segments', [{ text: 'A' }, { text: 'B' }, { text: 'C' }]);
    fixture.componentRef.setInput('value', '1');
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelectorAll('.mui-value-chip-divider').length).toBe(2);
  });
});
