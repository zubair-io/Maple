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
    const refreshFolderChildren = vi.fn();
    TestBed.configureTestingModule({
      imports: [MoveToTreePickerComponent],
      providers: [
        { provide: LibraryStateService, useValue: { refreshFolderChildren } },
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

    const sourceLabel = root.querySelectorAll('button')[1] as HTMLButtonElement;
    sourceLabel.click();
    expect(selected).toEqual([]);
    expect(root.getAttribute('aria-disabled')).toBeNull();
    expect(sourceLabel.disabled).toBe(true);
    const chevron = root.querySelector('button') as HTMLButtonElement;
    expect(root.contains(chevron)).toBe(true);
    expect(chevron.disabled).toBe(false);
    expect(chevron.getAttribute('aria-disabled')).toBeNull();
    expect(chevron.getAttribute('aria-label')).toBe('Expand Photos');
    chevron.click();
    expect(refreshFolderChildren).toHaveBeenCalledWith(source.id);
    chevron.click();
    chevron.click();
    expect(refreshFolderChildren).toHaveBeenCalledTimes(1);

    fixture.componentRef.setInput('nodes', [{ ...source, children: [child] }]);
    fixture.detectChanges();
    const rows = fixture.nativeElement.querySelectorAll(
      '[role=treeitem]',
    ) as NodeListOf<HTMLElement>;
    expect(rows).toHaveLength(2);
    expect(rows[0].querySelector('[role=group]')?.contains(rows[1])).toBe(true);
    (rows[1].querySelectorAll('button')[1] as HTMLButtonElement).click();
    expect(selected).toEqual([child]);
  });

  it('does not refresh a Windows filesystem path as a Maple address', () => {
    const refreshFolderChildren = vi.fn();
    const expandFsFolder = vi.fn();
    const windowsFolder: SidebarEntry = {
      kind: 'folder',
      id: 'c:\\photos',
      absPath: 'c:\\photos',
      label: 'Photos',
      count: null,
    };
    TestBed.configureTestingModule({
      imports: [MoveToTreePickerComponent],
      providers: [
        { provide: LibraryStateService, useValue: { refreshFolderChildren, expandFsFolder } },
        { provide: DRAG_MOVE_CAPABILITY, useValue: { dropDisabledReason: () => null } },
      ],
    });
    const fixture = TestBed.createComponent(MoveToTreePickerComponent);
    fixture.componentRef.setInput('nodes', [windowsFolder]);
    fixture.componentRef.setInput('sourceFolderId', 'c:\\source');
    fixture.detectChanges();

    const button = fixture.nativeElement.querySelector('button') as HTMLButtonElement;
    button.click();
    expect(refreshFolderChildren).not.toHaveBeenCalled();
    expect(expandFsFolder).toHaveBeenCalledWith(windowsFolder);
  });

  it('does not treat a colon-free source as the prefix of another library', () => {
    const refreshFolderChildren = vi.fn();
    TestBed.configureTestingModule({
      imports: [MoveToTreePickerComponent],
      providers: [
        { provide: LibraryStateService, useValue: { refreshFolderChildren } },
        { provide: DRAG_MOVE_CAPABILITY, useValue: { dropDisabledReason: () => null } },
      ],
    });
    const fixture = TestBed.createComponent(MoveToTreePickerComponent);
    fixture.componentRef.setInput('nodes', [{ ...child, id: 'photo:target' }]);
    fixture.componentRef.setInput('sourceFolderId', 'photos');
    fixture.detectChanges();

    const button = fixture.nativeElement.querySelector('button') as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(refreshFolderChildren).not.toHaveBeenCalled();
  });
});
