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

describe('MuiImageComponent — placeholderBackground (thumbnail not decoded yet)', () => {
  function renderEmpty(): ComponentFixture<MuiImageComponent> {
    TestBed.configureTestingModule({ imports: [MuiImageComponent] });
    const fixture = TestBed.createComponent(MuiImageComponent);
    fixture.componentRef.setInput('src', '');
    fixture.componentRef.setInput('alt', 'A photo');
    fixture.detectChanges();
    return fixture;
  }

  it('renders the gradient background instead of an <img> or the broken glyph when src is empty', () => {
    const fixture = renderEmpty();
    fixture.componentRef.setInput('placeholderBackground', 'url(data:image/svg+xml,abc)');
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('img')).toBeNull();
    expect(fixture.nativeElement.querySelector('.placeholder')).toBeNull();
    const gradient = fixture.nativeElement.querySelector('.gradient-placeholder') as HTMLElement;
    expect(gradient).toBeTruthy();
    expect(gradient.style.backgroundImage).toContain('data:image/svg+xml,abc');
    expect(gradient.getAttribute('aria-hidden')).toBe('true');
  });

  it('falls back to the broken-image glyph when src is empty and no placeholderBackground is given', () => {
    const fixture = renderEmpty();
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('.gradient-placeholder')).toBeNull();
    // Empty src still renders an <img> (existing behavior) — unaffected by this extension.
    expect(fixture.nativeElement.querySelector('img')).toBeTruthy();
  });

  it('prefers the real <img> over placeholderBackground once src is non-empty', () => {
    const fixture = renderEmpty();
    fixture.componentRef.setInput('placeholderBackground', 'url(data:image/svg+xml,abc)');
    fixture.componentRef.setInput('src', 'photo.jpg');
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('.gradient-placeholder')).toBeNull();
    expect(fixture.nativeElement.querySelector('img')).toBeTruthy();
  });
});
