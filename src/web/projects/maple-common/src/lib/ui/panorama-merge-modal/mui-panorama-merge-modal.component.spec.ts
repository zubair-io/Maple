import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import type { ComponentFixture } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';

import type {
  MuiPanoramaFrame,
  MuiPanoramaMergeSettings,
} from './mui-panorama-merge-modal.component';
import { MuiPanoramaMergeModalComponent } from './mui-panorama-merge-modal.component';

const FRAMES: readonly MuiPanoramaFrame[] = [
  { id: '1', src: 'frame1.jpg', alt: 'Frame 1' },
  { id: '2', src: 'frame2.jpg', alt: 'Frame 2' },
  { id: '3', src: 'frame3.jpg', alt: 'Frame 3' },
];

@Component({
  standalone: true,
  imports: [MuiPanoramaMergeModalComponent],
  template: `
    <mui-panorama-merge-modal
      [open]="open()"
      [frames]="frames()"
      [(projection)]="projection"
      [(blendMode)]="blendMode"
      [boundaryWarpReason]="reason()"
      [stitching]="stitching()"
      [progress]="progress()"
      (boundaryWarpCommitted)="committedWarp.push($event)"
      (mergeRequested)="onMergeRequested($event)"
      (dismissed)="dismissedCount = dismissedCount + 1"
    />
  `,
})
class HostComponent {
  readonly open = signal(true);
  readonly frames = signal<readonly MuiPanoramaFrame[]>(FRAMES);
  readonly projection = signal('spherical');
  readonly blendMode = signal('linear');
  readonly stitching = signal(false);
  readonly progress = signal(0);
  readonly reason = signal<string | null>(null);
  readonly committedWarp: number[] = [];
  dismissedCount = 0;
  lastSettings: MuiPanoramaMergeSettings | null = null;

  onMergeRequested(settings: MuiPanoramaMergeSettings): void {
    this.lastSettings = settings;
  }
}

function render(): { fixture: ComponentFixture<HostComponent>; host: HostComponent } {
  TestBed.configureTestingModule({ imports: [HostComponent] });
  const fixture = TestBed.createComponent(HostComponent);
  fixture.detectChanges();
  return { fixture, host: fixture.componentInstance };
}

describe('MuiPanoramaMergeModalComponent', () => {
  it('renders one media cell per source frame', () => {
    const { fixture } = render();
    expect(fixture.nativeElement.querySelectorAll('mui-media-cell').length).toBe(3);
  });

  it('selecting projection and blend mode segments updates their models', () => {
    const { fixture, host } = render();
    const toggles = fixture.nativeElement.querySelectorAll('mui-segmented-toggle');
    const projectionSegments = toggles[0].querySelectorAll(
      '.segment',
    ) as NodeListOf<HTMLButtonElement>;
    const blendSegments = toggles[1].querySelectorAll('.segment') as NodeListOf<HTMLButtonElement>;

    projectionSegments[2].click(); // perspective
    blendSegments[1].click(); // multi-band
    fixture.detectChanges();

    expect(host.projection()).toBe('perspective');
    expect(host.blendMode()).toBe('multi-band');
  });

  it('emits mergeRequested with the current settings on Merge', () => {
    const { fixture, host } = render();
    const buttons = fixture.nativeElement.querySelectorAll(
      '.mui-panorama-merge-modal-footer button',
    );
    (buttons[1] as HTMLButtonElement).click();
    expect(host.lastSettings).toEqual({
      projection: 'spherical',
      blendMode: 'linear',
      boundaryWarp: 0,
      autoCrop: false,
    });
  });

  it('shows the Edges group between Blend mode and the progress bar, and carries its values into Merge', () => {
    const { fixture, host } = render();
    host.stitching.set(true);
    fixture.detectChanges();
    const body = fixture.nativeElement.querySelector(
      '.mui-panorama-merge-modal-body',
    ) as HTMLElement;
    const order = [...body.children].map((el) => el.tagName.toLowerCase());
    expect(order.indexOf('mui-panorama-edges')).toBeGreaterThan(order.indexOf('div', 2));
    expect(order.indexOf('mui-panorama-edges')).toBeLessThan(order.indexOf('mui-progress'));

    host.stitching.set(false);
    fixture.detectChanges();
    const slider = fixture.nativeElement.querySelector(
      '[data-testid="pano-boundary-warp"] input',
    ) as HTMLInputElement;
    slider.value = '40';
    slider.dispatchEvent(new Event('input'));
    slider.dispatchEvent(new Event('change'));
    (
      fixture.nativeElement.querySelector(
        '[data-testid="pano-auto-crop"] button',
      ) as HTMLButtonElement
    ).click();
    fixture.detectChanges();
    (
      fixture.nativeElement.querySelectorAll(
        '.mui-panorama-merge-modal-footer button',
      )[1] as HTMLButtonElement
    ).click();
    expect(host.lastSettings).toMatchObject({ boundaryWarp: 40, autoCrop: true });
    expect(host.committedWarp).toEqual([40]);
  });

  it('disables the edge controls while stitching and shows the reason at full opacity', () => {
    const { fixture, host } = render();
    host.reason.set('Not applied: warping this shape would fold the image.');
    host.stitching.set(true);
    fixture.detectChanges();
    const slider = fixture.nativeElement.querySelector(
      '[data-testid="pano-boundary-warp"] input',
    ) as HTMLInputElement;
    const toggle = fixture.nativeElement.querySelector(
      '[data-testid="pano-auto-crop"] button',
    ) as HTMLButtonElement;
    expect(slider.disabled).toBe(true);
    expect(toggle.disabled).toBe(true);
    const reason = fixture.nativeElement.querySelector(
      '[data-testid="pano-boundary-warp-reason"]',
    ) as HTMLElement;
    expect(reason.textContent).toContain('would fold the image');
    expect(reason.closest('.mui-chrome-control-disabled')).toBeNull();
  });

  it('shows a progress bar while stitching', () => {
    const { fixture, host } = render();
    host.stitching.set(true);
    host.progress.set(55);
    fixture.detectChanges();
    const bar = fixture.nativeElement.querySelector('mui-progress .bar-fill') as HTMLElement;
    expect(bar.style.width).toBe('55%');
  });

  it('disables Merge with fewer than two frames', () => {
    const { fixture, host } = render();
    host.frames.set([FRAMES[0]]);
    fixture.detectChanges();
    const mergeButton = fixture.nativeElement.querySelectorAll(
      '.mui-panorama-merge-modal-footer button',
    )[1] as HTMLButtonElement;
    expect(mergeButton.disabled).toBe(true);
  });
});
