import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import {
  BATCH_RENAME_ENABLED,
  DRAG_MOVE_CAPABILITY,
  LibraryStateService,
  TRASH_CAPABILITY,
} from '@maple-common';
import { describe, expect, it, vi } from 'vitest';
import { SelfHostedBrowseController } from '../self-hosted-browse/self-hosted-browse.controller';
import { BrowseActionButtonComponent } from './browse-action-button.component';
import { SelfHostedBrowseActionsComponent } from './self-hosted-browse-actions.component';

function toolbar() {
  const photos = signal(2);
  const folders = signal(1);
  const busy = signal(false);
  const summary = signal({ trashed: 2, total: 3, failed: [{ id: 'failed-photo' }] });
  const controller = {
    openMetadata: vi.fn(),
    openPano: vi.fn(),
    openBatchRename: vi.fn(),
    openMoveTo: vi.fn(),
  };
  const trashAssets = vi.fn();
  const dismissSummary = vi.fn();
  TestBed.configureTestingModule({
    imports: [SelfHostedBrowseActionsComponent],
    providers: [
      {
        provide: LibraryStateService,
        useValue: {
          selectedCount: photos,
          selectedTotalCount: () => photos() + folders(),
          selectedSourceId: () => 'library',
          selectedAssetIds: () => new Set(['photo-1', 'photo-2']),
          selectedFolderIds: () => new Set(['folder-1']),
        },
      },
      { provide: SelfHostedBrowseController, useValue: controller },
      { provide: BATCH_RENAME_ENABLED, useValue: true },
      { provide: DRAG_MOVE_CAPABILITY, useValue: { available: () => true } },
      {
        provide: TRASH_CAPABILITY,
        useValue: {
          available: () => true,
          busy,
          resultSummary: summary,
          trashAssets,
          dismissSummary,
        },
      },
    ],
  });
  const fixture = TestBed.createComponent(SelfHostedBrowseActionsComponent);
  fixture.detectChanges();
  const button = (name: string): HTMLButtonElement =>
    fixture.nativeElement.querySelector(`button[aria-label="${name}"]`);
  return { fixture, photos, folders, busy, controller, trashAssets, dismissSummary, button };
}

describe('Self Hosted Browse shared buttons', () => {
  it('forwards the real disabled state, name, tooltip and selection count to the native control', () => {
    TestBed.configureTestingModule({ imports: [BrowseActionButtonComponent] });
    const fixture = TestBed.createComponent(BrowseActionButtonComponent);
    const clicked = vi.fn();
    fixture.componentInstance.clicked.subscribe(clicked);
    for (const [key, value] of Object.entries({
      enabled: false,
      label: 'Move to…',
      count: 3,
      buttonTitle: 'Move selected photos and folders',
      ariaLabel: 'Move to',
    }))
      fixture.componentRef.setInput(key, value);
    fixture.detectChanges();
    const native: HTMLButtonElement = fixture.nativeElement.querySelector('mui-button button');
    expect(native.disabled).toBe(true);
    expect(native.getAttribute('aria-label')).toBe('Move to');
    expect(native.title).toBe('Move selected photos and folders');
    expect(native.textContent?.trim()).toBe('Move to…');
    native.click();
    expect(clicked).not.toHaveBeenCalled();
    fixture.componentRef.setInput('enabled', true);
    fixture.detectChanges();
    expect(native.textContent?.trim()).toBe('Move to… (3)');
    native.click();
    expect(clicked).toHaveBeenCalledOnce();
  });

  it('keeps all controller commands and includes folders only in move and Trash counts', () => {
    const { button, controller, trashAssets } = toolbar();
    for (const [name, action] of [
      ['Edit metadata', controller.openMetadata],
      ['Merge to panorama', controller.openPano],
      ['Batch rename', controller.openBatchRename],
      ['Move to', controller.openMoveTo],
    ] as const) {
      button(name).click();
      expect(action).toHaveBeenCalledOnce();
    }
    expect(button('Edit metadata').textContent).toContain('(2)');
    expect(button('Move to').textContent).toContain('(3)');
    button('Move to Trash').click();
    expect(trashAssets).toHaveBeenCalledWith(['photo-1', 'photo-2'], 'library', ['folder-1']);
  });

  it('disables photo actions for folder-only selection and prevents duplicate Trash while busy', () => {
    const { fixture, photos, button, busy, trashAssets } = toolbar();
    photos.set(0);
    fixture.detectChanges();
    for (const name of ['Edit metadata', 'Merge to panorama', 'Batch rename'])
      expect(button(name).disabled).toBe(true);
    expect(button('Move to').disabled).toBe(false);
    expect(button('Move to').textContent).toContain('(1)');
    busy.set(true);
    fixture.detectChanges();
    button('Move to Trash').click();
    expect(button('Move to Trash').disabled).toBe(true);
    expect(trashAssets).not.toHaveBeenCalled();
  });

  it('keeps the partial Trash result announced and dismisses it through the shared native button', () => {
    const { fixture, button, dismissSummary } = toolbar();
    expect(fixture.nativeElement.querySelector('[role="status"]').textContent).toContain(
      'Sent 2 of 3 to Trash',
    );
    button('Dismiss').click();
    expect(dismissSummary).toHaveBeenCalledOnce();
  });
});
