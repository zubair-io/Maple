import { TestBed } from '@angular/core/testing';
import type { ComponentFixture } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';

import { MuiCardComponent } from './mui-card.component';

function render(): ComponentFixture<MuiCardComponent> {
  TestBed.configureTestingModule({ imports: [MuiCardComponent] });
  const fixture = TestBed.createComponent(MuiCardComponent);
  fixture.componentRef.setInput('src', 'https://example.com/cover.jpg');
  fixture.componentRef.setInput('alt', 'Ballet');
  fixture.componentRef.setInput('title', 'Ballet');
  fixture.componentRef.setInput('subtitle', '142 photos');
  fixture.detectChanges();
  return fixture;
}

describe('MuiCardComponent', () => {
  it('renders title and subtitle text', () => {
    const fixture = render();
    const text = fixture.nativeElement.textContent as string;
    expect(text).toContain('Ballet');
    expect(text).toContain('142 photos');
  });

  it('emits pressed on click and on Enter/Space', () => {
    const fixture = render();
    let count = 0;
    fixture.componentInstance.pressed.subscribe(() => count++);

    (fixture.nativeElement.querySelector('.mui-card') as HTMLElement).click();
    expect(count).toBe(1);

    const card = fixture.nativeElement.querySelector('.mui-card') as HTMLElement;
    card.dispatchEvent(new KeyboardEvent('keydown', { key: ' ' }));
    expect(count).toBe(2);
  });

  it('renders a badge only when badgeLabel is provided', () => {
    const fixture = render();
    expect(fixture.nativeElement.querySelector('.overlay')).toBeNull();
    fixture.componentRef.setInput('badgeLabel', 'New');
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.overlay')).toBeTruthy();
  });
});
