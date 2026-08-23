import { TestBed } from '@angular/core/testing';
import type { ComponentFixture } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';

import type { MuiContextMenuEntry } from '../context-menu/mui-context-menu.component';
import { MuiSidebarComponent } from './mui-sidebar.component';
import type { MuiSidebarSection } from './mui-sidebar.component';

const SECTIONS: readonly MuiSidebarSection[] = [
  {
    id: 'cloud',
    label: 'MAPLE CLOUD',
    nodes: [
      {
        id: 'notebooks',
        label: 'Notebooks',
        icon: 'folder',
        children: [
          { id: 'personal', label: 'Personal' },
          { id: 'work', label: 'Work' },
        ],
      },
    ],
  },
  {
    id: 'local',
    label: 'LOCAL',
    nodes: [{ id: 'journal', label: 'Journal' }],
  },
];

const CONTEXT_ENTRIES: readonly MuiContextMenuEntry[] = [
  { id: 'rename', label: 'Rename' },
  { id: 'delete', label: 'Delete' },
];

function render(): ComponentFixture<MuiSidebarComponent> {
  const fixture = TestBed.createComponent(MuiSidebarComponent);
  fixture.componentRef.setInput('sections', SECTIONS);
  fixture.componentRef.setInput('contextMenuEntries', CONTEXT_ENTRIES);
  fixture.detectChanges();
  return fixture;
}

describe('MuiSidebarComponent', () => {
  it('flattens the tree with collapsed branches contributing no child rows', () => {
    const fixture = render();

    // notebooks + journal — Personal/Work stay hidden until expanded.
    expect(fixture.nativeElement.querySelectorAll('mui-tree-row').length).toBe(2);

    fixture.componentInstance.expandedIds.set(['notebooks']);
    fixture.detectChanges();

    const rows = fixture.nativeElement.querySelectorAll('mui-tree-row');
    expect(rows.length).toBe(4);
  });

  it('sets activeId when a row is pressed', () => {
    const fixture = render();
    const row = fixture.nativeElement.querySelector('mui-tree-row .mui-tree-row') as HTMLElement;
    row.click();
    fixture.detectChanges();

    expect(fixture.componentInstance.activeId()).toBe('notebooks');
  });

  it('opens the context menu on right-click and emits contextAction with the row id on select', () => {
    const fixture = render();
    fixture.componentInstance.expandedIds.set(['notebooks']);
    fixture.detectChanges();

    // Flattened order: notebooks, personal, work, journal.
    const rows = fixture.nativeElement.querySelectorAll(
      'mui-tree-row .mui-tree-row',
    ) as NodeListOf<HTMLElement>;
    const personalRow = rows[1];

    let captured: { nodeId: string; actionId: string } | null = null;
    fixture.componentInstance.contextAction.subscribe((event) => (captured = event));

    personalRow.dispatchEvent(
      new MouseEvent('contextmenu', { bubbles: true, clientX: 40, clientY: 60 }),
    );
    fixture.detectChanges();

    expect(fixture.componentInstance.contextMenuOpen()).toBe(true);

    const menuItem = fixture.nativeElement.querySelector(
      'mui-context-menu .item',
    ) as HTMLButtonElement;
    menuItem.click();

    expect(captured).toEqual({ nodeId: 'personal', actionId: 'rename' });
    expect(fixture.componentInstance.contextMenuOpen()).toBe(false);
  });

  it('shows the empty state when every section has zero nodes', () => {
    const fixture = TestBed.createComponent(MuiSidebarComponent);
    fixture.componentRef.setInput('sections', [{ id: 'cloud', label: 'MAPLE CLOUD', nodes: [] }]);
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('mui-empty-state')).toBeTruthy();
    expect(fixture.nativeElement.querySelectorAll('mui-tree-row').length).toBe(0);
  });

  it('shows a spinner instead of the tree while loading', () => {
    const fixture = TestBed.createComponent(MuiSidebarComponent);
    fixture.componentRef.setInput('sections', SECTIONS);
    fixture.componentRef.setInput('loading', true);
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('mui-spinner')).toBeTruthy();
    expect(fixture.nativeElement.querySelectorAll('mui-tree-row').length).toBe(0);
  });
});
