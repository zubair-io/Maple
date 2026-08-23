import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import type { ComponentFixture } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';

import type { MuiBatchMetadataValues } from './mui-batch-metadata-modal.component';
import { MuiBatchMetadataModalComponent } from './mui-batch-metadata-modal.component';

@Component({
  standalone: true,
  imports: [MuiBatchMetadataModalComponent],
  template: `
    <mui-batch-metadata-modal
      [open]="open()"
      [itemCount]="itemCount()"
      [(copyright)]="copyright"
      [(keywords)]="keywords"
      [(rating)]="rating"
      [applying]="applying()"
      [progress]="progress()"
      (applyRequested)="onApplyRequested($event)"
      (dismissed)="dismissedCount = dismissedCount + 1"
    />
  `,
})
class HostComponent {
  readonly open = signal(true);
  readonly itemCount = signal(12);
  readonly copyright = signal('© 2026 Studio');
  readonly keywords = signal<readonly string[]>(['sports']);
  readonly rating = signal(0);
  readonly applying = signal(false);
  readonly progress = signal(0);
  dismissedCount = 0;
  lastValues: MuiBatchMetadataValues | null = null;

  onApplyRequested(values: MuiBatchMetadataValues): void {
    this.lastValues = values;
  }
}

function render(): { fixture: ComponentFixture<HostComponent>; host: HostComponent } {
  TestBed.configureTestingModule({ imports: [HostComponent] });
  const fixture = TestBed.createComponent(HostComponent);
  fixture.detectChanges();
  return { fixture, host: fixture.componentInstance };
}

function applyButton(fixture: ComponentFixture<HostComponent>): HTMLButtonElement {
  return fixture.nativeElement.querySelectorAll(
    '.mui-batch-metadata-modal-footer button',
  )[1] as HTMLButtonElement;
}

describe('MuiBatchMetadataModalComponent', () => {
  it('clicking Apply opens the confirm dialog instead of applying immediately', () => {
    const { fixture, host } = render();
    applyButton(fixture).click();
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.mui-dialog')).not.toBeNull();
    expect(host.lastValues).toBeNull();
  });

  it('confirming the dialog emits applyRequested with the current field values', () => {
    const { fixture, host } = render();
    applyButton(fixture).click();
    fixture.detectChanges();

    const confirm = fixture.nativeElement.querySelectorAll('.mui-dialog .actions button')[1];
    (confirm as HTMLButtonElement).click();
    fixture.detectChanges();

    expect(host.lastValues).toEqual({
      copyright: '© 2026 Studio',
      keywords: ['sports'],
      rating: 0,
    });
    expect(fixture.nativeElement.querySelector('.mui-dialog')).toBeNull();
  });

  it('dismissing the confirm dialog does not apply', () => {
    const { fixture, host } = render();
    applyButton(fixture).click();
    fixture.detectChanges();

    const cancel = fixture.nativeElement.querySelectorAll('.mui-dialog .actions button')[0];
    (cancel as HTMLButtonElement).click();
    fixture.detectChanges();

    expect(host.lastValues).toBeNull();
    expect(fixture.nativeElement.querySelector('.mui-dialog')).toBeNull();
  });

  it('adding a keyword chip updates the bound keywords model', () => {
    const { fixture, host } = render();
    const addControl = fixture.nativeElement.querySelector(
      'mui-chip-row .add .control',
    ) as HTMLInputElement;
    addControl.value = 'ballet';
    addControl.dispatchEvent(new Event('input'));
    addControl.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    fixture.detectChanges();
    expect(host.keywords()).toEqual(['sports', 'ballet']);
  });

  it('shows a progress bar while applying', () => {
    const { fixture, host } = render();
    host.applying.set(true);
    host.progress.set(30);
    fixture.detectChanges();
    const bar = fixture.nativeElement.querySelector('mui-progress .bar-fill') as HTMLElement;
    expect(bar.style.width).toBe('30%');
  });
});
