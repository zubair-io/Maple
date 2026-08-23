// Drives the tier state machine synchronously via the public
// `handleTierLoaded`/`handleTierError` handlers instead of racing real
// `Image` network loads (see the component header comment).

import { TestBed } from '@angular/core/testing';
import type { ComponentFixture } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';

import { MuiRemoteImageComponent } from './mui-remote-image.component';

function render(): ComponentFixture<MuiRemoteImageComponent> {
  TestBed.configureTestingModule({ imports: [MuiRemoteImageComponent] });
  const fixture = TestBed.createComponent(MuiRemoteImageComponent);
  fixture.componentRef.setInput('alt', 'A remote photo');
  return fixture;
}

describe('MuiRemoteImageComponent', () => {
  it('starts in the loading state with no tiers configured', () => {
    const fixture = render();
    fixture.componentRef.setInput('tiers', {});
    fixture.detectChanges();
    expect(fixture.componentInstance.status()).toBe('error');
  });

  it('displays the thumb tier immediately once it resolves, blurred', () => {
    const fixture = render();
    const tiers = { thumb: 'thumb.jpg', preview: 'preview.jpg', full: 'full.jpg' };
    fixture.componentRef.setInput('tiers', tiers);
    fixture.detectChanges();

    fixture.componentInstance.handleTierLoaded('thumb', 'thumb.jpg', tiers);
    fixture.detectChanges();
    expect(fixture.componentInstance.status()).toBe('loaded');
    expect(fixture.componentInstance.displayTier()).toBe('thumb');
    const img = fixture.nativeElement.querySelector('img') as HTMLImageElement;
    expect(img.className).toContain('tier-thumb');
  });

  it('sharpens through preview to full as each tier resolves', () => {
    const fixture = render();
    const tiers = { thumb: 'thumb.jpg', preview: 'preview.jpg', full: 'full.jpg' };
    fixture.componentRef.setInput('tiers', tiers);
    fixture.detectChanges();

    fixture.componentInstance.handleTierLoaded('thumb', 'thumb.jpg', tiers);
    fixture.componentInstance.handleTierLoaded('preview', 'preview.jpg', tiers);
    fixture.detectChanges();
    expect(fixture.componentInstance.displayTier()).toBe('preview');

    fixture.componentInstance.handleTierLoaded('full', 'full.jpg', tiers);
    fixture.detectChanges();
    expect(fixture.componentInstance.displayTier()).toBe('full');
    expect((fixture.nativeElement.querySelector('img') as HTMLImageElement).className).toContain(
      'tier-full',
    );
  });

  it('skips a failed tier and keeps trying the rest, only erroring if all fail', () => {
    const fixture = render();
    const tiers = { thumb: 'thumb.jpg', full: 'full.jpg' };
    fixture.componentRef.setInput('tiers', tiers);
    fixture.detectChanges();

    fixture.componentInstance.handleTierError(tiers);
    fixture.detectChanges();
    expect(fixture.componentInstance.status()).toBe('loading');

    fixture.componentInstance.handleTierLoaded('full', 'full.jpg', tiers);
    fixture.detectChanges();
    expect(fixture.componentInstance.status()).toBe('loaded');
  });

  it('reports error and shows a retry affordance once every tier fails', () => {
    const fixture = render();
    const tiers = { thumb: 'thumb.jpg' };
    fixture.componentRef.setInput('tiers', tiers);
    fixture.detectChanges();

    fixture.componentInstance.handleTierError(tiers);
    fixture.detectChanges();
    expect(fixture.componentInstance.status()).toBe('error');
    expect(fixture.nativeElement.querySelector('.retry')).toBeTruthy();
  });

  it('retry re-runs the whole tier sequence from scratch', () => {
    const fixture = render();
    const tiers = { thumb: 'thumb.jpg' };
    fixture.componentRef.setInput('tiers', tiers);
    fixture.detectChanges();
    fixture.componentInstance.handleTierError(tiers);
    fixture.detectChanges();
    expect(fixture.componentInstance.status()).toBe('error');

    (fixture.nativeElement.querySelector('.retry') as HTMLButtonElement).click();
    fixture.detectChanges();
    expect(fixture.componentInstance.status()).toBe('loading');
  });
});
