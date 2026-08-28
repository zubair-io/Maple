import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import type { ComponentFixture } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';

import type {
  MuiExportModalPhase,
  MuiExportResultBanner,
  MuiExportSettings,
} from './mui-export-modal.component';
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

// ── #3046: 4-phase state machine + size picker + choice blurbs ─────────
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
      [phase]="phase()"
      [formatDetail]="formatDetail()"
      [colorSpaceDetail]="colorSpaceDetail()"
      [qualityVisible]="qualityVisible()"
      [sizeOptions]="sizeOptions"
      [(maxSidePixels)]="maxSidePixels"
      [sizeHint]="sizeHint()"
      [progress]="progress()"
      [doneMessage]="doneMessage()"
      [doneDetail]="doneDetail()"
      [errorDetail]="errorDetail()"
      (exportRequested)="onExportRequested($event)"
      (dismissed)="dismissedCount = dismissedCount + 1"
      (retryRequested)="retryCount = retryCount + 1"
    />
  `,
})
class PhasedHostComponent {
  readonly open = signal(true);
  readonly formatOptions = [
    { value: 'jpeg', label: 'JPEG' },
    { value: 'tiff', label: 'TIFF' },
  ];
  readonly colorSpaceOptions = [{ value: 'srgb', label: 'sRGB' }];
  readonly sizeOptions = [
    { value: 0, label: 'Full resolution' },
    { value: 2048, label: 'Long edge 2048 px' },
  ];
  readonly format = signal('jpeg');
  readonly quality = signal(92);
  readonly colorSpace = signal('srgb');
  readonly maxSidePixels = signal(0);
  readonly phase = signal<MuiExportModalPhase>('options');
  readonly formatDetail = signal<string | null>('8-bit, compressed.');
  readonly colorSpaceDetail = signal<string | null>('Safest everywhere.');
  readonly qualityVisible = signal(true);
  readonly sizeHint = signal<string | null>('Output: 4000 × 3000 px.');
  readonly progress = signal(0);
  readonly doneMessage = signal<string | null>('Exported test.jpg');
  readonly doneDetail = signal<string | null>('4000 × 3000 px');
  readonly errorDetail = signal<string | null>('Disk full.');
  dismissedCount = 0;
  retryCount = 0;
  lastRequest: MuiExportSettings | null = null;

  onExportRequested(settings: MuiExportSettings): void {
    this.lastRequest = settings;
  }
}

function renderPhased(): {
  fixture: ComponentFixture<PhasedHostComponent>;
  host: PhasedHostComponent;
} {
  TestBed.configureTestingModule({ imports: [PhasedHostComponent] });
  const fixture = TestBed.createComponent(PhasedHostComponent);
  fixture.detectChanges();
  return { fixture, host: fixture.componentInstance };
}

describe('MuiExportModalComponent — #3046 phase machine', () => {
  it('options phase shows the format/color-space blurbs and the size picker', () => {
    const { fixture } = renderPhased();
    const hints = Array.from(
      fixture.nativeElement.querySelectorAll('.field-hint'),
    ) as HTMLElement[];
    expect(hints.map((h) => h.textContent?.trim())).toContain('8-bit, compressed.');
    expect(hints.map((h) => h.textContent?.trim())).toContain('Safest everywhere.');
    expect(hints.map((h) => h.textContent?.trim())).toContain('Output: 4000 × 3000 px.');
    expect(fixture.nativeElement.querySelectorAll('mui-segmented-toggle').length).toBe(3); // format, color space, size
  });

  it('hides the Quality field when qualityVisible is false', () => {
    const { fixture, host } = renderPhased();
    expect(fixture.nativeElement.querySelector('mui-form-field')).not.toBeNull();

    host.qualityVisible.set(false);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('mui-form-field')).toBeNull();
  });

  it('selecting a size segment updates the bound maxSidePixels model', () => {
    const { fixture, host } = renderPhased();
    const sizeToggle = fixture.nativeElement.querySelectorAll('mui-segmented-toggle')[2];
    const segments = sizeToggle.querySelectorAll('.segment') as NodeListOf<HTMLButtonElement>;
    segments[1].click();
    fixture.detectChanges();
    expect(host.maxSidePixels()).toBe(2048);
  });

  it('exporting phase renders a dedicated pane with no footer and suppresses the header close button', () => {
    const { fixture, host } = renderPhased();
    host.phase.set('exporting');
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('.mui-export-modal-footer')).toBeNull();
    expect(fixture.nativeElement.querySelector('.mui-export-modal-header mui-button')).toBeNull();
    expect(fixture.nativeElement.querySelector('mui-progress')).not.toBeNull();

    // Escape/scrim-click must be a no-op mid-export — the busy guard.
    fixture.componentInstance.dismissedCount = 0;
    (fixture.nativeElement.querySelector('.mui-overlay-shell-scrim') as HTMLElement).dispatchEvent(
      new MouseEvent('click', { bubbles: true }),
    );
    expect(fixture.componentInstance.dismissedCount).toBe(0);
  });

  it('done phase renders a success banner, detail, and a single Done action', () => {
    const { fixture, host } = renderPhased();
    host.phase.set('done');
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('mui-banner .message')?.textContent).toContain(
      'Exported test.jpg',
    );
    expect(fixture.nativeElement.textContent).toContain('4000 × 3000 px');

    const buttons = fixture.nativeElement.querySelectorAll('.mui-export-modal-footer button');
    expect(buttons.length).toBe(1);
    (buttons[0] as HTMLButtonElement).click();
    expect(host.dismissedCount).toBe(1);
  });

  it('error phase renders an error banner, detail, and Close/Try again actions', () => {
    const { fixture, host } = renderPhased();
    host.phase.set('error');
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('mui-banner .message')?.textContent).toContain(
      'Export failed',
    );
    expect(fixture.nativeElement.textContent).toContain('Disk full.');

    const buttons = fixture.nativeElement.querySelectorAll(
      '.mui-export-modal-footer button',
    ) as NodeListOf<HTMLButtonElement>;
    expect(buttons.length).toBe(2);
    buttons[1].click();
    expect(host.retryCount).toBe(1);
  });

  it('exportRequested carries maxSidePixels alongside format/quality/colorSpace', () => {
    const { fixture, host } = renderPhased();
    host.maxSidePixels.set(2048);
    fixture.detectChanges();

    const buttons = fixture.nativeElement.querySelectorAll('.mui-export-modal-footer button');
    (buttons[1] as HTMLButtonElement).click();

    expect(host.lastRequest).toEqual({
      format: 'jpeg',
      quality: 92,
      colorSpace: 'srgb',
      maxSidePixels: 2048,
    });
  });
});
