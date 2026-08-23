import { TestBed } from '@angular/core/testing';
import type { ComponentFixture } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';

import { MuiImageComponent } from './mui-image.component';

function render(): ComponentFixture<MuiImageComponent> {
  TestBed.configureTestingModule({ imports: [MuiImageComponent] });
  const fixture = TestBed.createComponent(MuiImageComponent);
  fixture.componentRef.setInput('src', 'photo.jpg');
  fixture.componentRef.setInput('alt', 'A photo');
  fixture.detectChanges();
  return fixture;
}

describe('MuiImageComponent', () => {
  it('renders the img with fit/radius classes and fades in on load', () => {
    const fixture = render();
    const img = fixture.nativeElement.querySelector('img') as HTMLImageElement;
    expect(img.src).toContain('photo.jpg');
    expect(img.alt).toBe('A photo');
    expect(img.className).toContain('fit-fill');
    expect(img.className).not.toContain('is-loaded');

    img.dispatchEvent(new Event('load'));
    fixture.detectChanges();
    expect((fixture.nativeElement.querySelector('img') as HTMLImageElement).className).toContain(
      'is-loaded',
    );
  });

  it('reflects fit and radius inputs as classes', () => {
    const fixture = render();
    fixture.componentRef.setInput('fit', 'fit');
    fixture.componentRef.setInput('radius', 'full');
    fixture.detectChanges();
    const img = fixture.nativeElement.querySelector('img') as HTMLImageElement;
    expect(img.className).toContain('fit-fit');
    expect(fixture.nativeElement.querySelector('.mui-image').className).toContain('radius-full');
  });

  it('swaps to a placeholder glyph on error instead of the browser broken-image icon', () => {
    const fixture = render();
    const img = fixture.nativeElement.querySelector('img') as HTMLImageElement;
    img.dispatchEvent(new Event('error'));
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('img')).toBeNull();
    const placeholder = fixture.nativeElement.querySelector('.placeholder') as HTMLElement;
    expect(placeholder).toBeTruthy();
    expect(placeholder.getAttribute('aria-label')).toBe('A photo');
    expect(placeholder.querySelector('mui-icon')).toBeTruthy();
  });

  it('resets the broken state when `src` changes to a new value', () => {
    const fixture = render();
    fixture.nativeElement.querySelector('img').dispatchEvent(new Event('error'));
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.placeholder')).toBeTruthy();

    fixture.componentRef.setInput('src', 'other.jpg');
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('img')).toBeTruthy();
    expect(fixture.nativeElement.querySelector('.placeholder')).toBeNull();
  });
});
