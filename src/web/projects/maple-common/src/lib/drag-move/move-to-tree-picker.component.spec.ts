import { TestBed } from '@angular/core/testing';
import { describe, expect, it, vi } from 'vitest';
import { LibraryStateService } from '../state/library-state.service';
import type { SidebarEntry } from '../models/folder';
import { DRAG_MOVE_CAPABILITY } from './drag-move-capability';
import { MoveToTreePickerComponent } from './move-to-tree-picker.component';

const source: SidebarEntry = {
  kind: 'folder',
  id: 'photos:',
  label: 'Photos',
  count: null,
  children: [],
  childrenStatus: 'loaded',
};
const child: SidebarEntry = {
  kind: 'folder',
  id: 'photos:target',
  label: 'Target',
  count: null,
};

describe('MoveToTreePickerComponent', () => {
  it('can open an ineligible source folder, fetch a newly created child, and select the child', () => {
    const refreshFolderListing = vi.fn();
    TestBed.configureTestingModule({
      imports: [MoveToTreePickerComponent],
      providers: [
        { provide: LibraryStateService, useValue: { refreshFolderListing } },
        {
          provide: DRAG_MOVE_CAPABILITY,
          useValue: {
            dropDisabledReason: (node: SidebarEntry) =>
              node.id === source.id ? 'Already in this folder' : null,
          },
        },
      ],
    });

    const fixture = TestBed.createComponent(MoveToTreePickerComponent);
    fixture.componentRef.setInput('nodes', [source]);
    fixture.componentRef.setInput('sourceFolderId', source.id);
    fixture.detectChanges();
    const root = fixture.nativeElement.querySelector('[role=treeitem]') as HTMLElement;
    const selected: SidebarEntry[] = [];
    fixture.componentInstance.select.subscribe((node) => selected.push(node));

    root.click();
    expect(selected).toEqual([]);
    expect(root.getAttribute('aria-disabled')).toBe('false');
    (root.querySelector('button') as HTMLButtonElement).click();
    expect(refreshFolderListing).toHaveBeenCalledWith(source.id);

    fixture.componentRef.setInput('nodes', [{ ...source, children: [child] }]);
    fixture.detectChanges();
    const rows = fixture.nativeElement.querySelectorAll(
      '[role=treeitem]',
    ) as NodeListOf<HTMLElement>;
    expect(rows).toHaveLength(2);
    rows[1].click();
    expect(selected).toEqual([child]);
  });
});
