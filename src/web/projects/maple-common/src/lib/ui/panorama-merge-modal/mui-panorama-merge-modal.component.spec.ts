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
      [stitching]="stitching()"
      [progress]="progress()"
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
    expect(host.lastSettings).toEqual({ projection: 'spherical', blendMode: 'linear' });
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
