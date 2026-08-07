import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { describe, expect, it, vi } from 'vitest';
import { of, throwError } from 'rxjs';
import { HttpErrorResponse } from '@angular/common/http';
import { LibraryStateService } from '../../state/library-state.service';
import { FolderCrudService } from '../../api/folder-crud.service';
import { SidebarEntry } from '../../models/folder';
import { ApiFolder } from '../../workspace/server-library-io';
import { provideFolderTreeExtensions } from './folder-tree-extension';
import { FolderTreeComponent } from './folder-tree.component';
import { validateFolderNameDraft } from './folder-name-validation';

@Component({ standalone: true, template: 'Header action' })
class TestHeaderComponent {}

@Component({ standalone: true, template: 'Body action' })
class TestBodyComponent {}

describe('FolderTreeComponent extensions', () => {
  it('renders app-provided header and body controls in normal-flow slots', () => {
    TestBed.configureTestingModule({
      imports: [FolderTreeComponent],
      providers: [
        {
          provide: LibraryStateService,
          useValue: { sidebarTree: signal([]) },
        },
        provideFolderTreeExtensions({
          header: TestHeaderComponent,
          body: TestBodyComponent,
        }),
      ],
    });

    const fixture = TestBed.createComponent(FolderTreeComponent);
    fixture.detectChanges();
    const header = fixture.nativeElement.querySelector('.section-bar');

    expect(header.textContent).toContain('Header action');
    expect(header.textContent).not.toContain('Body action');
    expect(fixture.nativeElement.textContent).toContain('Body action');
  });
});

describe('validateFolderNameDraft (#2643 light client-side pre-check)', () => {
  it('rejects an empty (or whitespace-only) name', () => {
    expect(validateFolderNameDraft('')).not.toBeNull();
    expect(validateFolderNameDraft('   ')).not.toBeNull();
  });

  it('rejects a name containing a path separator', () => {
    expect(validateFolderNameDraft('a/b')).not.toBeNull();
  });

  it('rejects "." and ".." as traversal components', () => {
    expect(validateFolderNameDraft('.')).not.toBeNull();
    expect(validateFolderNameDraft('..')).not.toBeNull();
  });

  it('accepts a plausible name — the server is authoritative beyond this', () => {
    expect(validateFolderNameDraft('2026 Vacation')).toBeNull();
  });
});

/** Registered library the fixture tree's root node resolves to via its
 * `slug:relPath` id (see `FolderTreeComponent.resolveLibraryId`). */
const LIBRARY: ApiFolder = {
  id: '64f0000000000000000000ab',
  path: '/Users/x/Photos',
  slug: 'lib1',
  label: 'My Library',
  last_scan: null,
  file_count: 10,
  created_at: '2026-01-01T00:00:00Z',
};

function makeTree(): SidebarEntry[] {
  return [
    {
      kind: 'folder',
      id: 'lib1:',
      label: 'My Library',
      count: 10,
      open: true,
      children: [
        {
          kind: 'folder',
          id: 'lib1:2026',
          label: '2026',
          count: 3,
        },
      ],
    },
  ];
}

function makeStateStub(tree: SidebarEntry[]) {
  return {
    sidebarTree: signal(tree),
    folderOpen: signal<Record<string, boolean>>({}),
    selectedSourceId: signal('lib1:2026'),
    registeredFolders: signal<ApiFolder[]>([LIBRARY]),
    viewMode: signal('folder'),
    setViewMode: vi.fn(),
    setFolderOpen: vi.fn(),
    expandFsFolder: vi.fn(),
    openSelfHostedSubfolder: vi.fn(),
    toggleSection: vi.fn(),
    sectionOpen: signal<Record<string, boolean>>({}),
  };
}

interface CrudStubOverrides {
  mkdir?: FolderCrudService['mkdir'];
  move?: FolderCrudService['move'];
  trashFolder?: FolderCrudService['trashFolder'];
}

function setup(crudOverrides: CrudStubOverrides = {}) {
  const state = makeStateStub(makeTree());
  const crud = {
    mkdir: vi.fn(() => of({ abs_path: '/Users/x/Photos/2026/New Folder' })),
    move: vi.fn(() => of({ abs_path: '/Users/x/Photos/2027' })),
    trashFolder: vi.fn(() => of({ total: 1, succeeded: 1, failed: 0, items: [] })),
    ...crudOverrides,
  };

  TestBed.configureTestingModule({
    imports: [FolderTreeComponent],
    providers: [
      { provide: LibraryStateService, useValue: state },
      { provide: FolderCrudService, useValue: crud },
    ],
  });

  const fixture = TestBed.createComponent(FolderTreeComponent);
  fixture.detectChanges();
  return { fixture, state, crud };
}

function rowFor(fixture: ReturnType<typeof setup>['fixture'], label: string): HTMLElement {
  const rows = Array.from(fixture.nativeElement.querySelectorAll('.tree-row')) as HTMLElement[];
  const row = rows.find((r) => r.textContent?.includes(label));
  if (!row) throw new Error(`no tree row found for "${label}"`);
  return row;
}

function fireContextMenu(el: HTMLElement): void {
  const event = new MouseEvent('contextmenu', {
    bubbles: true,
    cancelable: true,
    clientX: 40,
    clientY: 80,
  });
  el.dispatchEvent(event);
}

describe('FolderTreeComponent folder-tree context menu (#2643)', () => {
  it('opens on right-click with New Folder enabled and Rename/Trash disabled+explained on the library root', () => {
    const { fixture } = setup();
    fireContextMenu(rowFor(fixture, 'My Library'));
    fixture.detectChanges();

    const items = fixture.nativeElement.querySelectorAll('button[role="menuitem"]');
    expect(items.length).toBe(3);
    const rename = Array.from(items).find((b) =>
      (b as HTMLElement).textContent?.includes('Rename'),
    ) as HTMLButtonElement;
    const trash = Array.from(items).find((b) =>
      (b as HTMLElement).textContent?.includes('Move to Trash'),
    ) as HTMLButtonElement;
    expect(rename.disabled).toBe(true);
    expect(trash.disabled).toBe(true);
    expect(rename.title).toContain("can't be renamed");
  });

  it('enables Rename/Trash on a real subfolder', () => {
    const { fixture } = setup();
    fireContextMenu(rowFor(fixture, '2026'));
    fixture.detectChanges();

    const items = fixture.nativeElement.querySelectorAll('button[role="menuitem"]');
    const rename = Array.from(items).find((b) =>
      (b as HTMLElement).textContent?.includes('Rename'),
    ) as HTMLButtonElement;
    const trash = Array.from(items).find((b) =>
      (b as HTMLElement).textContent?.includes('Move to Trash'),
    ) as HTMLButtonElement;
    expect(rename.disabled).toBe(false);
    expect(trash.disabled).toBe(false);
  });

  it('Escape closes the menu', () => {
    const { fixture } = setup();
    fireContextMenu(rowFor(fixture, '2026'));
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('[role="menu"]')).not.toBeNull();

    const menu = fixture.nativeElement.querySelector('[role="menu"]') as HTMLElement;
    menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('[role="menu"]')).toBeNull();
  });

  it('New Folder: submits mkdir with the target relPath inside the right-clicked node and refreshes on success', () => {
    const { fixture, state, crud } = setup();
    fireContextMenu(rowFor(fixture, '2026'));
    fixture.detectChanges();

    const newFolderBtn = Array.from(
      fixture.nativeElement.querySelectorAll('button[role="menuitem"]'),
    ).find((b) => (b as HTMLElement).textContent?.includes('New Folder')) as HTMLButtonElement;
    newFolderBtn.click();
    fixture.detectChanges();

    const input = fixture.nativeElement.querySelector('.fnf-input') as HTMLInputElement;
    expect(input).not.toBeNull();
    const createBtn = fixture.nativeElement.querySelector('.fnf-btn-primary') as HTMLButtonElement;
    expect(createBtn.disabled).toBe(true); // empty name

    input.value = 'March';
    input.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    expect(createBtn.disabled).toBe(false);

    createBtn.click();
    fixture.detectChanges();

    expect(crud.mkdir).toHaveBeenCalledWith(LIBRARY.id, '2026/March');
    expect(state.expandFsFolder).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'lib1:2026', childrenStatus: undefined }),
    );
    expect(fixture.nativeElement.querySelector('.fnf-card')).toBeNull();
  });

  it('New Folder: surfaces a server rejection inline instead of silently failing', () => {
    const { fixture } = setup({
      mkdir: vi.fn(() =>
        throwError(() => new HttpErrorResponse({ status: 400, error: { error: 'Reserved name' } })),
      ),
    });
    fireContextMenu(rowFor(fixture, '2026'));
    fixture.detectChanges();
    (
      Array.from(fixture.nativeElement.querySelectorAll('button[role="menuitem"]')).find((b) =>
        (b as HTMLElement).textContent?.includes('New Folder'),
      ) as HTMLButtonElement
    ).click();
    fixture.detectChanges();

    const input = fixture.nativeElement.querySelector('.fnf-input') as HTMLInputElement;
    input.value = 'CON';
    input.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    (fixture.nativeElement.querySelector('.fnf-btn-primary') as HTMLButtonElement).click();
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('.fnf-error')?.textContent).toContain(
      'Reserved name',
    );
  });

  it('Rename: goes inline and calls move with source/target relPaths on Enter', () => {
    const { fixture, crud } = setup();
    fireContextMenu(rowFor(fixture, '2026'));
    fixture.detectChanges();
    (
      Array.from(fixture.nativeElement.querySelectorAll('button[role="menuitem"]')).find((b) =>
        (b as HTMLElement).textContent?.includes('Rename'),
      ) as HTMLButtonElement
    ).click();
    fixture.detectChanges();

    const input = fixture.nativeElement.querySelector('.folder-rename-input') as HTMLInputElement;
    expect(input).not.toBeNull();
    expect(input.value).toBe('2026');

    input.value = '2027';
    input.dispatchEvent(new Event('input'));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    fixture.detectChanges();

    expect(crud.move).toHaveBeenCalledWith(LIBRARY.id, '2026', '2027');
  });

  it('Move to Trash: confirmation names the actual folder and calls trashFolder on confirm', () => {
    const { fixture, crud } = setup();
    fireContextMenu(rowFor(fixture, '2026'));
    fixture.detectChanges();
    (
      Array.from(fixture.nativeElement.querySelectorAll('button[role="menuitem"]')).find((b) =>
        (b as HTMLElement).textContent?.includes('Move to Trash'),
      ) as HTMLButtonElement
    ).click();
    fixture.detectChanges();

    const dialog = fixture.nativeElement.querySelector('[role="alertdialog"]');
    expect(dialog?.textContent).toContain('"2026"');

    const confirmBtn = fixture.nativeElement.querySelector(
      '.ftc-btn-destructive',
    ) as HTMLButtonElement;
    confirmBtn.click();
    fixture.detectChanges();

    expect(crud.trashFolder).toHaveBeenCalledWith(LIBRARY.id, '2026');
  });

  it('Move to Trash: a partial-failure summary surfaces a warning instead of a silent success', () => {
    const { fixture } = setup({
      trashFolder: vi.fn(() =>
        of({
          total: 2,
          succeeded: 1,
          failed: 1,
          items: [{ assetId: 'a1', filename: 'x.dng', ok: false, error: 'locked' }],
        }),
      ),
    });
    fireContextMenu(rowFor(fixture, '2026'));
    fixture.detectChanges();
    (
      Array.from(fixture.nativeElement.querySelectorAll('button[role="menuitem"]')).find((b) =>
        (b as HTMLElement).textContent?.includes('Move to Trash'),
      ) as HTMLButtonElement
    ).click();
    fixture.detectChanges();
    (fixture.nativeElement.querySelector('.ftc-btn-destructive') as HTMLButtonElement).click();
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('.trash-partial-warning')?.textContent).toContain(
      '1 of 2',
    );
  });
});
