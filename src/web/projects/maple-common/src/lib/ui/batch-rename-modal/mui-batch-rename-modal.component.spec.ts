import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import type { ComponentFixture } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';

import type {
  MuiBatchRenameResult,
  MuiBatchRenameSourceItem,
} from './mui-batch-rename-modal.component';
import { MuiBatchRenameModalComponent } from './mui-batch-rename-modal.component';

const ITEMS: readonly MuiBatchRenameSourceItem[] = [
  { id: 'a', filename: 'IMG_001.dng', date: '2026-03-04', camera: 'X100' },
  { id: 'b', filename: 'IMG_002.dng', date: '2026-03-04', camera: 'X100' },
];

@Component({
  standalone: true,
  imports: [MuiBatchRenameModalComponent],
  template: `
    <mui-batch-rename-modal
      [open]="open()"
      [items]="items"
      [(template)]="template"
      [startNumber]="startNumber()"
      [renaming]="renaming()"
      [progress]="progress()"
      (renameConfirmed)="onConfirmed($event)"
      (dismissed)="dismissedCount = dismissedCount + 1"
    />
  `,
})
class HostComponent {
  readonly open = signal(true);
  readonly items = ITEMS;
  readonly template = signal('{date}_{seq}');
  readonly startNumber = signal(1);
  readonly renaming = signal(false);
  readonly progress = signal(0);
  dismissedCount = 0;
  lastResult: MuiBatchRenameResult | null = null;

  onConfirmed(result: MuiBatchRenameResult): void {
    this.lastResult = result;
  }
}

function render(): { fixture: ComponentFixture<HostComponent>; host: HostComponent } {
  TestBed.configureTestingModule({ imports: [HostComponent] });
  const fixture = TestBed.createComponent(HostComponent);
  fixture.detectChanges();
  return { fixture, host: fixture.componentInstance };
}

describe('MuiBatchRenameModalComponent', () => {
  it('computes the live preview from the initial template', () => {
    const { fixture } = render();
    const rows = fixture.nativeElement.querySelectorAll('mui-preview-list mui-list-row');
    expect(rows.length).toBe(2);
    expect(rows[0].textContent).toContain('IMG_001.dng');
    expect(rows[0].textContent).toContain('2026-03-04_001');
    expect(rows[1].textContent).toContain('2026-03-04_002');
  });

  it('recomputes the preview live when the template signal changes', () => {
    const { fixture, host } = render();
    host.template.set('{camera}-{seq}');
    fixture.detectChanges();
    const rows = fixture.nativeElement.querySelectorAll('mui-preview-list mui-list-row');
    expect(rows[0].textContent).toContain('X100-001');
    expect(rows[1].textContent).toContain('X100-002');
  });

  it('respects a custom start number in the {seq} token', () => {
    const { fixture, host } = render();
    host.startNumber.set(10);
    fixture.detectChanges();
    const rows = fixture.nativeElement.querySelectorAll('mui-preview-list mui-list-row');
    expect(rows[0].textContent).toContain('_010');
    expect(rows[1].textContent).toContain('_011');
  });

  it('clicking a token chip appends it to the template', () => {
    const { fixture, host } = render();
    host.template.set('');
    fixture.detectChanges();
    const chips = fixture.nativeElement.querySelectorAll(
      'mui-chip-row .chip',
    ) as NodeListOf<HTMLButtonElement>;
    chips[1].click(); // {seq}
    fixture.detectChanges();
    expect(host.template()).toBe('{seq}');
  });

  it('emits renameConfirmed with the template and computed mapping on Rename', () => {
    const { fixture, host } = render();
    const buttons = fixture.nativeElement.querySelectorAll('.mui-batch-rename-modal-footer button');
    (buttons[1] as HTMLButtonElement).click();
    expect(host.lastResult?.template).toBe('{date}_{seq}');
    expect(host.lastResult?.mapping).toEqual([
      { id: 'a', before: 'IMG_001.dng', after: '2026-03-04_001' },
      { id: 'b', before: 'IMG_002.dng', after: '2026-03-04_002' },
    ]);
  });

  it('shows a progress bar while renaming', () => {
    const { fixture, host } = render();
    host.renaming.set(true);
    host.progress.set(60);
    fixture.detectChanges();
    const bar = fixture.nativeElement.querySelector('mui-progress .bar-fill') as HTMLElement;
    expect(bar.style.width).toBe('60%');
  });
});
