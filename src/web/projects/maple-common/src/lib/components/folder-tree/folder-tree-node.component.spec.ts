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

async function setup(node: SidebarEntry, opts: { crudEnabled?: boolean } = {}) {
  const state = makeStateStub();
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
