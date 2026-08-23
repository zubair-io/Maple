import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import type { ComponentFixture } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';

import type { MuiLibraryPickerEntry } from './mui-library-picker-modal.component';
import { MuiLibraryPickerModalComponent } from './mui-library-picker-modal.component';

const ENTRIES: readonly MuiLibraryPickerEntry[] = [
  { id: 'photos', name: 'Photos', kind: 'folder', itemCount: 12 },
  { id: 'img1', name: 'IMG_001.dng', kind: 'file' },
];

@Component({
  standalone: true,
  imports: [MuiLibraryPickerModalComponent],
  template: `
    <mui-library-picker-modal
      [open]="open()"
      [pathSegments]="pathSegments()"
      [entries]="entries()"
      [loading]="loading()"
      [error]="error()"
      [(selectedId)]="selectedId"
      (entrySelected)="onEntrySelected($event)"
      (folderOpened)="onFolderOpened($event)"
      (dismissed)="dismissedCount = dismissedCount + 1"
      (chosen)="chosenCount = chosenCount + 1"
      (backRequested)="backCount = backCount + 1"
      (refreshRequested)="refreshCount = refreshCount + 1"
    />
  `,
})
class HostComponent {
  readonly open = signal(true);
  readonly pathSegments = signal<readonly string[]>(['home-server', 'Photos']);
  readonly entries = signal<readonly MuiLibraryPickerEntry[]>(ENTRIES);
  readonly loading = signal(false);
  readonly error = signal<string | null>(null);
  readonly selectedId = signal<string | null>(null);
  dismissedCount = 0;
  chosenCount = 0;
  backCount = 0;
  refreshCount = 0;
  lastEntrySelected: string | null = null;
  lastFolderOpened: string | null = null;

  onEntrySelected(id: string): void {
    this.lastEntrySelected = id;
  }

  onFolderOpened(name: string): void {
    this.lastFolderOpened = name;
  }
}

function render(): { fixture: ComponentFixture<HostComponent>; host: HostComponent } {
  TestBed.configureTestingModule({ imports: [HostComponent] });
  const fixture = TestBed.createComponent(HostComponent);
  fixture.detectChanges();
  return { fixture, host: fixture.componentInstance };
}

describe('MuiLibraryPickerModalComponent', () => {
  it('shows the populated entry list by default', () => {
    const { fixture } = render();
    expect(fixture.nativeElement.querySelectorAll('.entries mui-tree-row').length).toBe(2);
    expect(fixture.nativeElement.querySelector('mui-empty-state')).toBeNull();
  });

  it('shows a spinner while loading, hiding the entry list', () => {
    const { fixture, host } = render();
    host.loading.set(true);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('mui-spinner')).not.toBeNull();
    expect(fixture.nativeElement.querySelector('.entries')).toBeNull();
  });

  it('shows an error banner instead of the list when error is set', () => {
    const { fixture, host } = render();
    host.error.set('Connection lost');
    fixture.detectChanges();
    const banner = fixture.nativeElement.querySelector('mui-banner .message');
    expect(banner?.textContent).toContain('Connection lost');
    expect(fixture.nativeElement.querySelector('.entries')).toBeNull();
  });

  it('shows the empty state when the folder has no entries', () => {
    const { fixture, host } = render();
    host.entries.set([]);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('mui-empty-state')).not.toBeNull();
  });

  it('clicking a folder entry emits folderOpened with its name, not entrySelected', () => {
    const { fixture, host } = render();
    const rows = fixture.nativeElement.querySelectorAll('.entries .mui-tree-row');
    (rows[0] as HTMLElement).click();
    expect(host.lastFolderOpened).toBe('Photos');
    expect(host.lastEntrySelected).toBeNull();
  });

  it('clicking a file entry selects it and emits entrySelected', () => {
    const { fixture, host } = render();
    const rows = fixture.nativeElement.querySelectorAll('.entries .mui-tree-row');
    (rows[1] as HTMLElement).click();
    expect(host.lastEntrySelected).toBe('img1');
    expect(host.selectedId()).toBe('img1');
  });

  it('disables Choose until a selection is made, then emits chosen', () => {
    const { fixture, host } = render();
    const chooseButton = fixture.nativeElement.querySelectorAll(
      '.mui-library-picker-modal-footer button',
    )[1] as HTMLButtonElement;
    expect(chooseButton.disabled).toBe(true);

    const rows = fixture.nativeElement.querySelectorAll('.entries .mui-tree-row');
    (rows[1] as HTMLElement).click();
    fixture.detectChanges();
    expect(chooseButton.disabled).toBe(false);

    chooseButton.click();
    expect(host.chosenCount).toBe(1);
  });

  it('toolbar Back and Refresh actions emit their own outputs', () => {
    const { fixture, host } = render();
    const actions = fixture.nativeElement.querySelectorAll('mui-toolbar .mui-action-button');
    (actions[0] as HTMLButtonElement).click();
    expect(host.backCount).toBe(1);
    (actions[actions.length - 1] as HTMLButtonElement).click();
    expect(host.refreshCount).toBe(1);
  });
});
