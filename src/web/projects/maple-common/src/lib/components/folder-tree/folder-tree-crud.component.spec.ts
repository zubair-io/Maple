import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { describe, expect, it, vi } from 'vitest';
import { of, throwError } from 'rxjs';
import { HttpErrorResponse } from '@angular/common/http';
import { LibraryStateService } from '../../state/library-state.service';
import { FolderCrudService } from '../../api/folder-crud.service';
import { ApiFolder } from '../../workspace/server-library-io';
import {
  FolderTreeCrudComponent,
  FolderCrudMutation,
  FolderCrudRequest,
} from './folder-tree-crud.component';

const LIBRARY: ApiFolder = {
  id: '64f0000000000000000000ab',
  path: '/Users/x/Photos',
  slug: 'lib1',
  label: 'My Library',
  last_scan: null,
  file_count: 10,
  created_at: '2026-01-01T00:00:00Z',
};

function makeStateStub() {
  return {
    registeredFolders: signal<ApiFolder[]>([LIBRARY]),
  };
}

interface CrudStubOverrides {
  mkdir?: FolderCrudService['mkdir'];
  move?: FolderCrudService['move'];
  trashFolder?: FolderCrudService['trashFolder'];
}

@Component({
  standalone: true,
  imports: [FolderTreeCrudComponent],
  template: `@if (mounted()) {
    <app-folder-tree-crud
      [request]="request()"
      (closed)="onClosed()"
      (mutated)="onMutated($event)"
    />
  }`,
})
class HostComponent {
  request = signal<FolderCrudRequest>({
    node: { kind: 'folder', id: 'lib1:2026', label: '2026', count: null },
    x: 10,
    y: 20,
  });
  // Mirrors the real app: `folder-tree.component.ts` destroys
  // `FolderTreeCrudComponent` (by nulling the id gating its `@if`) as soon
  // as `closed` fires, so a fresh instance handles the next request.
  mounted = signal(true);
  closedCount = 0;
  mutations: FolderCrudMutation[] = [];
  onClosed(): void {
    this.closedCount++;
    this.mounted.set(false);
  }
  onMutated(m: FolderCrudMutation): void {
    this.mutations.push(m);
  }
}

const ROOT_REQUEST: FolderCrudRequest = {
  node: { kind: 'folder', id: 'lib1:', label: 'My Library', count: null },
  x: 10,
  y: 20,
};

function setup(crudOverrides: CrudStubOverrides = {}, request?: FolderCrudRequest) {
  const crud = {
    mkdir: vi.fn(() => of({ abs_path: '/x' })),
    move: vi.fn(() => of({ kind: 'ok' as const, result: { abs_path: '/x' } })),
    trashFolder: vi.fn(() => of({ total: 1, succeeded: 1, failed: 0, items: [] })),
    ...crudOverrides,
  };

  TestBed.configureTestingModule({
    imports: [HostComponent],
    providers: [
      { provide: LibraryStateService, useValue: makeStateStub() },
      { provide: FolderCrudService, useValue: crud },
    ],
  });

  const fixture = TestBed.createComponent(HostComponent);
  if (request) fixture.componentInstance.request.set(request);
  fixture.detectChanges();
  return { fixture, crud };
}

function menuButtons(fixture: ReturnType<typeof setup>['fixture']): HTMLButtonElement[] {
  return Array.from(fixture.nativeElement.querySelectorAll('button[role="menuitem"]'));
}

function clickMenuItem(fixture: ReturnType<typeof setup>['fixture'], label: string): void {
  const btn = menuButtons(fixture).find((b) => b.textContent?.includes(label));
  if (!btn) throw new Error(`no menu item "${label}"`);
  btn.click();
  fixture.detectChanges();
}

describe('FolderTreeCrudComponent (#2643 / #2705 review)', () => {
  it('shows the menu with Rename/Trash enabled for a real subfolder', () => {
    const { fixture } = setup();
    const items = menuButtons(fixture);
    expect(items.length).toBe(3);
    const rename = items.find((b) => b.textContent?.includes('Rename'))!;
    const trash = items.find((b) => b.textContent?.includes('Move to Trash'))!;
    expect(rename.disabled).toBe(false);
    expect(trash.disabled).toBe(false);
  });

  it('disables Rename/Trash with a title explanation on a library root', () => {
    const { fixture } = setup({}, ROOT_REQUEST);
    const items = menuButtons(fixture);
    const rename = items.find((b) => b.textContent?.includes('Rename'))!;
    const trash = items.find((b) => b.textContent?.includes('Move to Trash'))!;
    expect(rename.disabled).toBe(true);
    expect(trash.disabled).toBe(true);
    expect(rename.title).toContain("can't be renamed");
  });

  it('New Folder dialog input has an aria-label (Jules #2705 BLOCKING finding)', () => {
    const { fixture } = setup();
    clickMenuItem(fixture, 'New Folder');
    const input = fixture.nativeElement.querySelector('.fnf-input') as HTMLInputElement;
    expect(input.getAttribute('aria-label')).toBe('Folder name');
  });

  it('New Folder: submits mkdir with the target relPath and emits a mutation + closed', () => {
    const { fixture, crud } = setup();
    const host = fixture.componentInstance;
    clickMenuItem(fixture, 'New Folder');

    const input = fixture.nativeElement.querySelector('.fnf-input') as HTMLInputElement;
    input.value = 'March';
    input.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    (fixture.nativeElement.querySelector('.fnf-btn-primary') as HTMLButtonElement).click();
    fixture.detectChanges();

    expect(crud.mkdir).toHaveBeenCalledWith(LIBRARY.id, '2026/March');
    expect(host.mutations).toEqual([{ kind: 'created', parentId: 'lib1:2026' }]);
    expect(host.closedCount).toBe(1);
  });

  it('New Folder: clears a stale server error before retrying (Copilot #2705 finding)', () => {
    let shouldFail = true;
    const { fixture } = setup({
      mkdir: vi.fn(() =>
        shouldFail
          ? throwError(
              () => new HttpErrorResponse({ status: 400, error: { error: 'Reserved name' } }),
            )
          : of({ abs_path: '/x' }),
      ),
    });
    clickMenuItem(fixture, 'New Folder');
    const input = fixture.nativeElement.querySelector('.fnf-input') as HTMLInputElement;
    input.value = 'CON';
    input.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    (fixture.nativeElement.querySelector('.fnf-btn-primary') as HTMLButtonElement).click();
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.fnf-error')?.textContent).toContain(
      'Reserved name',
    );

    // Retry with a different name, this time the call succeeds — the stale
    // error must not still be visible once the dialog re-renders busy/idle.
    shouldFail = false;
    input.value = 'March';
    input.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    (fixture.nativeElement.querySelector('.fnf-btn-primary') as HTMLButtonElement).click();
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.fnf-card')).toBeNull();
  });

  it('Rename dialog is prefilled, has an aria-label, and calls move with source/target relPaths', () => {
    const { fixture, crud } = setup();
    const host = fixture.componentInstance;
    clickMenuItem(fixture, 'Rename');

    const input = fixture.nativeElement.querySelector('.frn-input') as HTMLInputElement;
    expect(input.value).toBe('2026');
    expect(input.getAttribute('aria-label')).toBe('Folder name');

    input.value = '2027';
    input.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    (fixture.nativeElement.querySelector('.frn-btn-primary') as HTMLButtonElement).click();
    fixture.detectChanges();

    expect(crud.move).toHaveBeenCalledWith(LIBRARY.id, '2026', '2027');
    expect(host.mutations).toEqual([
      { kind: 'renamed', oldId: 'lib1:2026', newId: 'lib1:2027', parentId: 'lib1:' },
    ]);
  });

  it('Rename: a 409 collision surfaces an actionable "name taken" message and keeps the dialog open with the typed name (#2949)', () => {
    const { fixture, crud } = setup({
      move: vi.fn(() => of({ kind: 'collision' as const })),
    });
    const host = fixture.componentInstance;
    clickMenuItem(fixture, 'Rename');

    const input = fixture.nativeElement.querySelector('.frn-input') as HTMLInputElement;
    input.value = '2027';
    input.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    (fixture.nativeElement.querySelector('.frn-btn-primary') as HTMLButtonElement).click();
    fixture.detectChanges();

    expect(crud.move).toHaveBeenCalledWith(LIBRARY.id, '2026', '2027');
    // Not a dropped/abandoned operation — no mutation emitted, dialog stays
    // mounted (not `closed`), and the user's typed name is still there to
    // retry with a different one.
    expect(host.mutations).toEqual([]);
    expect(host.closedCount).toBe(0);
    expect(fixture.nativeElement.querySelector('.frn-card')).not.toBeNull();
    expect((fixture.nativeElement.querySelector('.frn-input') as HTMLInputElement).value).toBe(
      '2027',
    );
    expect(fixture.nativeElement.querySelector('.frn-error')?.textContent).toContain(
      'already taken',
    );
  });

  it('Rename: submitting the unchanged name dismisses without calling the API', () => {
    const { fixture, crud } = setup();
    const host = fixture.componentInstance;
    clickMenuItem(fixture, 'Rename');
    (fixture.nativeElement.querySelector('.frn-btn-primary') as HTMLButtonElement).click();
    fixture.detectChanges();

    expect(crud.move).not.toHaveBeenCalled();
    expect(host.closedCount).toBe(1);
  });

  it('Rename: a concurrent duplicate submit is ignored while busy (Jules #2705 WARN)', () => {
    // Real UI can't reach this (the Confirm button disables while busy), but
    // the handler itself must also refuse to double-fire — defense in depth
    // against anything that could still call it (e.g. a fast double Enter
    // racing the disabled-attribute re-render). Call the method directly to
    // prove the guard exists independent of the DOM's disabled state.
    const { fixture, crud } = setup();
    const component = fixture.debugElement.children[0].componentInstance as FolderTreeCrudComponent;
    component.busy.set(true);
    component.onRenameConfirm('2027');

    expect(crud.move).not.toHaveBeenCalled();
  });

  it('Move to Trash: confirm names the folder, calls trash-folder, and surfaces a partial-failure summary', () => {
    const { fixture, crud } = setup({
      trashFolder: vi.fn(() =>
        of({
          total: 2,
          succeeded: 1,
          failed: 1,
          items: [{ assetId: 'a1', filename: 'x.dng', ok: false, error: 'locked' }],
        }),
      ),
    });
    const host = fixture.componentInstance;
    clickMenuItem(fixture, 'Move to Trash');

    const dialog = fixture.nativeElement.querySelector('[role="alertdialog"]');
    expect(dialog?.textContent).toContain('"2026"');

    (
      fixture.nativeElement.querySelector('.actions .variant-destructive') as HTMLButtonElement
    ).click();
    fixture.detectChanges();

    expect(crud.trashFolder).toHaveBeenCalledWith(LIBRARY.id, '2026');
    expect(host.mutations).toEqual([
      {
        kind: 'trashed',
        trashedId: 'lib1:2026',
        parentId: 'lib1:',
        partialFailureMessage: '1 of 2 item(s) in "2026" could not be moved to Trash.',
      },
    ]);
  });
});
