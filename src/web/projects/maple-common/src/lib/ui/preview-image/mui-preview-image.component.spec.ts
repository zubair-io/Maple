import { TestBed } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';

import { MuiPreviewImageComponent } from './mui-preview-image.component';

describe('MuiPreviewImageComponent', () => {
  it('shows the spinner overlay before the image reports load or error', () => {
    const fixture = TestBed.createComponent(MuiPreviewImageComponent);
    fixture.componentRef.setInput('src', 'https://example.test/photo.jpg');
    fixture.componentRef.setInput('alt', 'A photo');
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('.overlay mui-spinner')).toBeTruthy();
  });

  it('hides the spinner once the underlying image fires load', () => {
    const fixture = TestBed.createComponent(MuiPreviewImageComponent);
    fixture.componentRef.setInput('src', 'https://example.test/photo.jpg');
    fixture.componentRef.setInput('alt', 'A photo');
    fixture.detectChanges();

    const img = fixture.nativeElement.querySelector('img') as HTMLImageElement;
    img.dispatchEvent(new Event('load'));
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('.overlay')).toBeNull();
  });

  it('hides the spinner once the underlying image fires error, showing the broken placeholder', () => {
    const fixture = TestBed.createComponent(MuiPreviewImageComponent);
    fixture.componentRef.setInput('src', 'https://example.test/missing.jpg');
    fixture.componentRef.setInput('alt', 'A photo');
    fixture.detectChanges();

    const img = fixture.nativeElement.querySelector('img') as HTMLImageElement;
    img.dispatchEvent(new Event('error'));
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('.overlay')).toBeNull();
    expect(fixture.nativeElement.querySelector('.placeholder')).toBeTruthy();
  });

  it('resets the spinner when the src changes to a new image', () => {
    const fixture = TestBed.createComponent(MuiPreviewImageComponent);
    fixture.componentRef.setInput('src', 'https://example.test/photo.jpg');
    fixture.componentRef.setInput('alt', 'A photo');
    fixture.detectChanges();
    fixture.nativeElement.querySelector('img').dispatchEvent(new Event('load'));
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.overlay')).toBeNull();

    fixture.componentRef.setInput('src', 'https://example.test/other.jpg');
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.overlay')).toBeTruthy();
  });
});
