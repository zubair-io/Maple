import { TestBed } from '@angular/core/testing';
import type { ComponentFixture } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';

import { MuiVisionRowComponent } from './mui-vision-row.component';

function render(): ComponentFixture<MuiVisionRowComponent> {
  TestBed.configureTestingModule({ imports: [MuiVisionRowComponent] });
  const fixture = TestBed.createComponent(MuiVisionRowComponent);
  fixture.componentRef.setInput('labels', [
    { id: 'outdoor', label: 'outdoor' },
    { id: 'portrait', label: 'portrait' },
    { id: 'dance', label: 'dance' },
  ]);
  fixture.detectChanges();
  return fixture;
}

describe('MuiVisionRowComponent', () => {
  it('renders one chip per classification label', () => {
    const fixture = render();
    const chips = fixture.nativeElement.querySelectorAll('.chip');
    expect(chips.length).toBe(3);
    expect(fixture.nativeElement.textContent).toContain('outdoor');
    expect(fixture.nativeElement.textContent).toContain('dance');
  });
});
