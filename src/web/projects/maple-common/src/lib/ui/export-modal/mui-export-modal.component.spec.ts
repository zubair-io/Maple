import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import type { ComponentFixture } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';

import type { MuiExportResultBanner, MuiExportSettings } from './mui-export-modal.component';
import { MuiExportModalComponent } from './mui-export-modal.component';

@Component({
  standalone: true,
  imports: [MuiExportModalComponent],
  template: `
    <mui-export-modal
      [open]="open()"
      [formatOptions]="formatOptions"
      [colorSpaceOptions]="colorSpaceOptions"
      [(format)]="format"
      [(quality)]="quality"
      [(colorSpace)]="colorSpace"
      [exporting]="exporting()"
      [progress]="progress()"
      [resultBanner]="resultBanner()"
      (exportRequested)="onExportRequested($event)"
      (dismissed)="dismissedCount = dismissedCount + 1"
    />
  `,
})
class HostComponent {
  readonly open = signal(true);
  readonly formatOptions = [
    { value: 'jpeg', label: 'JPEG' },
    { value: 'png', label: 'PNG' },
  ];
  readonly colorSpaceOptions = [
    { value: 'srgb', label: 'sRGB' },
    { value: 'p3', label: 'Display P3' },
  ];
  readonly format = signal('jpeg');
  readonly quality = signal(90);
  readonly colorSpace = signal('srgb');
  readonly exporting = signal(false);
  readonly progress = signal(0);
  readonly resultBanner = signal<MuiExportResultBanner | null>(null);
  dismissedCount = 0;
  lastRequest: MuiExportSettings | null = null;

  onExportRequested(settings: MuiExportSettings): void {
    this.lastRequest = settings;
  }
}

function render(): { fixture: ComponentFixture<HostComponent>; host: HostComponent } {
  TestBed.configureTestingModule({ imports: [HostComponent] });
  const fixture = TestBed.createComponent(HostComponent);
  fixture.detectChanges();
  return { fixture, host: fixture.componentInstance };
}

describe('MuiExportModalComponent', () => {
  it('selecting a format segment updates the bound format model', () => {
    const { fixture, host } = render();
    const segments = fixture.nativeElement.querySelectorAll(
      'mui-segmented-toggle .segment',
    ) as NodeListOf<HTMLButtonElement>;
    segments[1].click();
    fixture.detectChanges();
    expect(host.format()).toBe('png');
  });

  it('emits exportRequested with the current settings on Export', () => {
    const { fixture, host } = render();
    host.quality.set(75);
    host.colorSpace.set('p3');
    fixture.detectChanges();

    const buttons = fixture.nativeElement.querySelectorAll('.mui-export-modal-footer button');
    (buttons[1] as HTMLButtonElement).click();

    expect(host.lastRequest).toEqual({ format: 'jpeg', quality: 75, colorSpace: 'p3' });
  });

  it('shows a progress bar while exporting, at the given value', () => {
    const { fixture, host } = render();
    host.exporting.set(true);
    host.progress.set(42);
    fixture.detectChanges();
    const bar = fixture.nativeElement.querySelector('mui-progress .bar-fill') as HTMLElement;
    expect(bar.style.width).toBe('42%');
  });

  it('renders a result banner when one is supplied', () => {
    const { fixture, host } = render();
    host.resultBanner.set({ message: 'Exported 4 files', variant: 'success' });
    fixture.detectChanges();
    const banner = fixture.nativeElement.querySelector('mui-banner .message');
    expect(banner?.textContent).toContain('Exported 4 files');
  });

  it('emits dismissed on Cancel', () => {
    const { fixture, host } = render();
    const buttons = fixture.nativeElement.querySelectorAll('.mui-export-modal-footer button');
    (buttons[0] as HTMLButtonElement).click();
    expect(host.dismissedCount).toBe(1);
  });
});
