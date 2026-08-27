import { Component, signal } from '@angular/core';
import { ComponentFixture, DeferBlockState, TestBed } from '@angular/core/testing';
import { of } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { LibraryStateService } from '../../state/library-state.service';
import { AuthService } from '../../auth/auth.service';
import { FolderCrudService } from '../../api/folder-crud.service';
import { SidebarEntry } from '../../models/folder';
import { provideFolderTreeExtensions } from './folder-tree-extension';
import { FOLDER_TREE_CRUD_ENABLED, provideFolderTreeCrud } from './folder-tree-crud-capability';
import { FolderTreeComponent } from './folder-tree.component';
import { validateFolderNameDraft } from './folder-name-validation';

@Component({ standalone: true, template: 'Header action' })
class TestHeaderComponent {}

@Component({ standalone: true, template: 'Body action' })
class TestBodyComponent {}

describe('FolderTreeComponent extensions', () => {
  it('renders app-provided header and body controls in normal-flow slots', async () => {
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
    // `FolderTreeComponent`'s template has a deferrable (`@defer`) block —
    // Angular's test compiler needs an explicit async compile step to
    // resolve deferred-block metadata before `createComponent` (#2643 /
    // #2705 review's bundle-split restructure introduced the `@defer`).
    await TestBed.compileComponents();

    const fixture = TestBed.createComponent(FolderTreeComponent);
    fixture.detectChanges();
    const header = fixture.nativeElement.querySelector('.section-bar');

    expect(header.textContent).toContain('Header action');
    expect(header.textContent).not.toContain('Body action');
    expect(fixture.nativeElement.textContent).toContain('Body action');
  });

  it('hides the Library section (header + tree) for a member without file access (#2893)', async () => {
    TestBed.configureTestingModule({
      imports: [FolderTreeComponent],
      providers: [
        {
          provide: LibraryStateService,
          useValue: {
            sidebarTree: signal<SidebarEntry[]>([
              { kind: 'folder', id: 'photos:', label: 'Photos', count: null },
            ]),
            selectedSourceId: signal(''),
            registeredFolders: signal([]),
          },
        },
        { provide: AuthService, useValue: { canBrowseFiles: false } },
        provideFolderTreeExtensions({
          header: TestHeaderComponent,
          body: TestBodyComponent,
        }),
      ],
    });
    await TestBed.compileComponents();

    const fixture = TestBed.createComponent(FolderTreeComponent);
    fixture.detectChanges();

    // No Library header (which also hosts the add-folder ＋ action) and no
    // library rows — but the extension body (Timeline/Map rows) stays.
    expect(fixture.nativeElement.querySelector('.section-bar')).toBeNull();
    expect(fixture.nativeElement.textContent).not.toContain('Photos');
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
    registeredFolders: signal([]),
    viewMode: signal('folder'),
    setViewMode: vi.fn(),
    setFolderOpen: vi.fn(),
    expandFsFolder: vi.fn(),
    openSelfHostedSubfolder: vi.fn(),
    toggleSection: vi.fn(),
    sectionOpen: signal<Record<string, boolean>>({}),
  };
}

type StateStub = ReturnType<typeof makeStateStub>;

async function setup(crudEnabled: boolean) {
  const state = makeStateStub(makeTree());
  TestBed.configureTestingModule({
    imports: [FolderTreeComponent],
    providers: [
      { provide: LibraryStateService, useValue: state },
      // Stubbed rather than omitted: if the deferred `FolderTreeCrudComponent`
      // actually instantiates during a test (its `@defer` trigger fires),
      // its constructor injects `FolderCrudService` unconditionally — the
      // real `providedIn: 'root'` service would otherwise try to resolve a
      // real `HttpClient` this TestBed never configured.
      {
        provide: FolderCrudService,
        useValue: {
          mkdir: vi.fn(() => of({ abs_path: '/x' })),
          move: vi.fn(() => of({ abs_path: '/x' })),
          trashFolder: vi.fn(() => of({ total: 0, succeeded: 0, failed: 0, items: [] })),
        },
      },
      ...(crudEnabled ? [provideFolderTreeCrud()] : []),
    ],
  });
  // See the "extensions" describe block above for why this is needed —
  // `FolderTreeComponent`'s template has a deferrable block.
  await TestBed.compileComponents();

  const fixture = TestBed.createComponent(FolderTreeComponent);
  fixture.detectChanges();
  return { fixture, state };
}

// `.mui-tree-row` — the recursive folder row now composes `<mui-tree-row>`
// (MW4, ticket #3031) rather than rendering its own `.tree-row` markup.
function rowFor(fixture: ComponentFixture<FolderTreeComponent>, label: string): HTMLElement {
  const rows = Array.from(fixture.nativeElement.querySelectorAll('.mui-tree-row')) as HTMLElement[];
  const row = rows.find((r) => r.textContent?.includes(label));
  if (!row) throw new Error(`no tree row found for "${label}"`);
  return row;
}

function fireContextMenu(el: HTMLElement): void {
  el.dispatchEvent(
    new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 80 }),
  );
}

describe('FolderTreeComponent — folder-tree CRUD capability gate (#2705 review)', () => {
  it('defaults to disabled: FOLDER_TREE_CRUD_ENABLED is false, so a right-click never opens the menu', async () => {
    const { fixture } = await setup(false);
    fireContextMenu(rowFor(fixture, '2026'));
    fixture.detectChanges();
    expect(fixture.componentInstance.crudRequest()).toBeNull();
  });

  it('provideFolderTreeCrud() turns the token on and a right-click sets crudRequest', async () => {
    const { fixture } = await setup(true);
    fireContextMenu(rowFor(fixture, '2026'));
    fixture.detectChanges();
    const request = fixture.componentInstance.crudRequest();
    expect(request?.node.id).toBe('lib1:2026');
  });

  it('injects FOLDER_TREE_CRUD_ENABLED=false at the root (@Injectable providedIn:root default)', () => {
    const enabled = TestBed.inject(FOLDER_TREE_CRUD_ENABLED);
    expect(enabled).toBe(false);
  });
});

describe('FolderTreeComponent — @defer wiring actually loads FolderTreeCrudComponent (#2705 review)', () => {
  it('renders the menu once the deferred block resolves', async () => {
    const { fixture } = await setup(true);
    fireContextMenu(rowFor(fixture, '2026'));
    fixture.detectChanges();

    const deferBlocks = await fixture.getDeferBlocks();
    expect(deferBlocks.length).toBe(1);
    await deferBlocks[0].render(DeferBlockState.Complete);
    fixture.detectChanges();

    const items = fixture.nativeElement.querySelectorAll('button[role="menuitem"]');
    expect(items.length).toBe(3);
  });
});

describe('FolderTreeComponent — crud outcome handling (#2705 review)', () => {
  function selectedSourceId(state: StateStub): string {
    return state.selectedSourceId();
  }

  it('a "created" mutation refreshes and opens the parent', async () => {
    const { fixture, state } = await setup(true);
    fixture.componentInstance.onCrudMutated({ kind: 'created', parentId: 'lib1:2026' });
    expect(state.expandFsFolder).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'lib1:2026', childrenStatus: undefined }),
    );
    expect(state.setFolderOpen).toHaveBeenCalledWith('lib1:2026', true);
  });

  it('a "renamed" mutation reconciles the exact selection onto the new address', async () => {
    const { fixture, state } = await setup(true);
    state.selectedSourceId.set('lib1:2026');
    fixture.componentInstance.onCrudMutated({
      kind: 'renamed',
      oldId: 'lib1:2026',
      newId: 'lib1:2027',
      parentId: 'lib1:',
    });
    // selectSidebarEntry falls to openSelfHostedSubfolder for an
    // M2-addressed id (contains ':').
    expect(state.openSelfHostedSubfolder).toHaveBeenCalledWith('2027', 'lib1:2027');
  });

  it('a "renamed" mutation reconciles a DESCENDANT selection by rewriting its prefix (Jules #2705 WARN)', async () => {
    const { fixture, state } = await setup(true);
    state.selectedSourceId.set('lib1:2026/March');
    fixture.componentInstance.onCrudMutated({
      kind: 'renamed',
      oldId: 'lib1:2026',
      newId: 'lib1:2027',
      parentId: 'lib1:',
    });
    expect(state.openSelfHostedSubfolder).toHaveBeenCalledWith('2027/March', 'lib1:2027/March');
  });

  it('a "trashed" mutation falls a descendant selection back to the parent', async () => {
    const { fixture, state } = await setup(true);
    state.selectedSourceId.set('lib1:2026/March');
    fixture.componentInstance.onCrudMutated({
      kind: 'trashed',
      trashedId: 'lib1:2026',
      parentId: 'lib1:',
      partialFailureMessage: null,
    });
    expect(state.openSelfHostedSubfolder).toHaveBeenCalledWith('', 'lib1:');
  });

  it('a "trashed" mutation with a partial-failure message surfaces it as a warning', async () => {
    const { fixture } = await setup(true);
    fixture.componentInstance.onCrudMutated({
      kind: 'trashed',
      trashedId: 'lib1:2026',
      parentId: 'lib1:',
      partialFailureMessage: '1 of 2 item(s) could not be moved to Trash.',
    });
    expect(fixture.componentInstance.trashPartialWarning()).toBe(
      '1 of 2 item(s) could not be moved to Trash.',
    );
  });

  it('a mutation for an unrelated selection leaves selectedSourceId untouched', async () => {
    const { fixture, state } = await setup(true);
    state.selectedSourceId.set('lib1:other-folder');
    fixture.componentInstance.onCrudMutated({
      kind: 'renamed',
      oldId: 'lib1:2026',
      newId: 'lib1:2027',
      parentId: 'lib1:',
    });
    expect(state.openSelfHostedSubfolder).not.toHaveBeenCalled();
    expect(selectedSourceId(state)).toBe('lib1:other-folder');
  });
});
