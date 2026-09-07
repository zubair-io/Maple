import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { describe, expect, it, vi } from 'vitest';
import { LibraryStateService } from '../../state/library-state.service';
import type { SidebarEntry } from '../../models/folder';
import { FOLDER_TREE_CRUD_ENABLED, provideFolderTreeCrud } from './folder-tree-crud-capability';
import { FolderTreeNodeComponent } from './folder-tree-node.component';

const LEAF: SidebarEntry = { kind: 'folder', id: 'lib1:2026', label: '2026', count: 3 };

const PARENT_WITH_CHILD: SidebarEntry = {
  kind: 'folder',
  id: 'lib1:',
  label: 'My Library',
  count: 10,
  open: true,
  children: [LEAF],
};

function makeStateStub() {
  return {
    sidebarTree: signal<SidebarEntry[]>([]),
    folderOpen: signal<Record<string, boolean>>({}),
    selectedSourceId: signal('lib1:2026'),
    viewMode: signal('folder'),
    setViewMode: vi.fn(),
    setFolderOpen: vi.fn(),
    expandFsFolder: vi.fn(),
    openSelfHostedSubfolder: vi.fn(),
  };
}

interface SetupOptions {
  crudEnabled?: boolean;
  /** The parent-derived inputs (#2847). Default to what a parent would
   * derive from an empty `folderOpen` map and no selection. */
  open?: boolean;
  selected?: boolean;
  folderOpen?: Record<string, boolean>;
  selectedSourceId?: string;
}

async function setup(node: SidebarEntry, opts: SetupOptions = {}) {
  const state = makeStateStub();
  if (opts.folderOpen) state.folderOpen.set(opts.folderOpen);
  if (opts.selectedSourceId !== undefined) state.selectedSourceId.set(opts.selectedSourceId);
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    imports: [FolderTreeNodeComponent],
    providers: [
      { provide: LibraryStateService, useValue: state },
      ...(opts.crudEnabled ? [provideFolderTreeCrud()] : []),
    ],
  });
  const fixture = TestBed.createComponent(FolderTreeNodeComponent);
  fixture.componentRef.setInput('node', node);
  fixture.componentRef.setInput('open', opts.open ?? node.open === true);
  fixture.componentRef.setInput('selected', opts.selected ?? false);
  fixture.detectChanges();
  return { fixture, state };
}

// `mui-tree-row`'s own template root (`.mui-tree-row`) is where the real
// interaction handlers live (click, and the native contextmenu/keydown
// listeners this component binds externally on `<mui-tree-row>` still catch
// events dispatched here via bubbling) — MW4, ticket #3031.
function row(fixture: { nativeElement: HTMLElement }): HTMLElement {
  return fixture.nativeElement.querySelector('.mui-tree-row') as HTMLElement;
}

describe('FolderTreeNodeComponent', () => {
  it('renders the node label', async () => {
    const { fixture } = await setup(LEAF);
    expect(fixture.nativeElement.textContent).toContain('2026');
  });

  it('clicking the row selects it via LibraryStateService', async () => {
    const { fixture, state } = await setup(LEAF);
    row(fixture).click();
    expect(state.openSelfHostedSubfolder).toHaveBeenCalled();
  });

  it('clicking the chevron expands a closed folder with children', async () => {
    const closedParent: SidebarEntry = { ...PARENT_WITH_CHILD, open: false };
    const { fixture, state } = await setup(closedParent);
    const chevron = fixture.nativeElement.querySelector('.chevron') as HTMLElement;
    chevron.click();
    expect(state.setFolderOpen).toHaveBeenCalledWith('lib1:', true);
  });

  it('clicking the chevron collapses an open folder', async () => {
    const { fixture, state } = await setup(PARENT_WITH_CHILD);
    const chevron = fixture.nativeElement.querySelector('.chevron') as HTMLElement;
    chevron.click();
    expect(state.setFolderOpen).toHaveBeenCalledWith('lib1:', false);
  });

  it('recursively renders a child folder row when open and loaded', async () => {
    const { fixture } = await setup(PARENT_WITH_CHILD);
    const childRows = fixture.nativeElement.querySelectorAll('app-folder-tree-node');
    expect(childRows.length).toBe(1);
    expect(fixture.nativeElement.textContent).toContain('2026');
  });

  describe('parent-derived open/selected (#2847)', () => {
    // The row's own state comes from its inputs — never from the shared
    // `folderOpen` map / `selectedSourceId` (the #2520 fan-out shape this
    // component reintroduced before #2847). The stub state is set to
    // DISAGREE with the inputs so a regression to reading it shows up.
    it('renders its own row from the inputs, not the shared state', async () => {
      const { fixture } = await setup(PARENT_WITH_CHILD, {
        open: false,
        selected: true,
        folderOpen: { 'lib1:': true },
        selectedSourceId: 'somewhere-else',
      });
      expect(fixture.nativeElement.querySelectorAll('app-folder-tree-node').length).toBe(0);
      expect(row(fixture).classList.contains('is-active')).toBe(true);
      expect(row(fixture).getAttribute('aria-expanded')).toBe('false');
    });

    it("derives each child row's open/selected once, from the shared state", async () => {
      const grandchild: SidebarEntry = {
        kind: 'folder',
        id: 'lib1:2026/06',
        label: '06',
        count: 1,
      };
      const child: SidebarEntry = { ...LEAF, open: false, children: [grandchild] };
      const parent: SidebarEntry = { ...PARENT_WITH_CHILD, children: [child] };
      const { fixture } = await setup(parent, {
        open: true,
        selected: false,
        folderOpen: { 'lib1:2026': true },
        selectedSourceId: 'lib1:2026',
      });
      const rows = fixture.nativeElement.querySelectorAll(
        '.mui-tree-row',
      ) as NodeListOf<HTMLElement>;
      // parent, child (expanded via the map override), grandchild
      expect(rows.length).toBe(3);
      expect(rows[0]!.classList.contains('is-active')).toBe(false);
      expect(rows[1]!.classList.contains('is-active')).toBe(true);
      expect(rows[1]!.getAttribute('aria-expanded')).toBe('true');
      expect(rows[2]!.classList.contains('is-active')).toBe(false);
    });

    it('a chevron toggle reports the flip of the parent-derived open input', async () => {
      const closedByDefault: SidebarEntry = { ...PARENT_WITH_CHILD, open: false };
      const { fixture, state } = await setup(closedByDefault, { open: true });
      (fixture.nativeElement.querySelector('.chevron') as HTMLElement).click();
      expect(state.setFolderOpen).toHaveBeenCalledWith('lib1:', false);
    });
  });

  describe('context-menu trigger (#2643)', () => {
    it('does nothing on right-click when FOLDER_TREE_CRUD_ENABLED is false', async () => {
      const { fixture } = await setup(LEAF, { crudEnabled: false });
      let emitted: unknown = null;
      fixture.componentInstance.crudRequested.subscribe((e) => (emitted = e));
      row(fixture).dispatchEvent(
        new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 5, clientY: 5 }),
      );
      expect(emitted).toBeNull();
    });

    it('emits crudRequested with a null invoker on right-click when enabled', async () => {
      const { fixture } = await setup(LEAF, { crudEnabled: true });
      let emitted: { request: { node: SidebarEntry }; invoker: HTMLElement | null } | null = null;
      fixture.componentInstance.crudRequested.subscribe((e) => (emitted = e));
      row(fixture).dispatchEvent(
        new MouseEvent('contextmenu', {
          bubbles: true,
          cancelable: true,
          clientX: 40,
          clientY: 80,
        }),
      );
      expect(emitted).not.toBeNull();
      expect(emitted!.request.node.id).toBe(LEAF.id);
      expect(emitted!.invoker).toBeNull();
    });

    it('emits crudRequested with the row as invoker on Shift+F10', async () => {
      const { fixture } = await setup(LEAF, { crudEnabled: true });
      let emitted: { invoker: HTMLElement | null } | null = null;
      fixture.componentInstance.crudRequested.subscribe((e) => (emitted = e));
      const r = row(fixture);
      r.dispatchEvent(new KeyboardEvent('keydown', { key: 'F10', shiftKey: true, bubbles: true }));
      expect(emitted).not.toBeNull();
      expect(emitted!.invoker).toBe(r);
    });

    it('a legacy fs: node is never crud-eligible even when enabled', async () => {
      const { fixture } = await setup({ ...LEAF, id: 'fs:/abs/path' }, { crudEnabled: true });
      let emitted: unknown = null;
      fixture.componentInstance.crudRequested.subscribe((e) => (emitted = e));
      row(fixture).dispatchEvent(
        new MouseEvent('contextmenu', { bubbles: true, cancelable: true }),
      );
      expect(emitted).toBeNull();
    });

    it('injects FOLDER_TREE_CRUD_ENABLED=false by default', () => {
      TestBed.resetTestingModule();
      TestBed.configureTestingModule({});
      expect(TestBed.inject(FOLDER_TREE_CRUD_ENABLED)).toBe(false);
    });
  });
});
