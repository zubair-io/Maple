import { signal } from '@angular/core';
import { describe, expect, it, vi } from 'vitest';
import type { LibraryStateService } from '../../state/library-state.service';
import type { SidebarEntry } from '../../models/folder';
import { selectSidebarEntry } from './source-selection';

function makeState(overrides: {
  viewMode?: 'folder' | 'timeline' | 'map';
  sidebarTree?: SidebarEntry[];
}) {
  const viewMode = signal<'folder' | 'timeline' | 'map'>(overrides.viewMode ?? 'folder');
  return {
    viewMode,
    setViewMode: vi.fn((mode: 'folder' | 'timeline' | 'map') => viewMode.set(mode)),
    sidebarTree: signal(overrides.sidebarTree ?? []),
    openSelfHostedSubfolder: vi.fn(),
    setFolderOpen: vi.fn(),
    selectedSourceId: signal(''),
  } as unknown as LibraryStateService & { setViewMode: ReturnType<typeof vi.fn> };
}

describe('selectSidebarEntry', () => {
  it('resets viewMode to folder when picking a tree entry while in timeline mode', () => {
    const state = makeState({ viewMode: 'timeline' });

    selectSidebarEntry(state, 'smart-picks');

    expect(state.setViewMode).toHaveBeenCalledWith('folder');
    expect(state.viewMode()).toBe('folder');
  });

  it('resets viewMode to folder when picking a tree entry while in map mode', () => {
    const state = makeState({ viewMode: 'map' });

    selectSidebarEntry(state, 'smart-picks');

    expect(state.setViewMode).toHaveBeenCalledWith('folder');
    expect(state.viewMode()).toBe('folder');
  });

  it('does not write viewMode again when already in folder mode', () => {
    const state = makeState({ viewMode: 'folder' });

    selectSidebarEntry(state, 'smart-picks');

    expect(state.setViewMode).not.toHaveBeenCalled();
  });

  it('FS-walks an absPath-bearing folder and opens it as a subfolder', () => {
    const state = makeState({
      viewMode: 'timeline',
      sidebarTree: [
        { kind: 'folder', id: 'f1', label: 'Vacation', count: null, absPath: '/lib/Vacation' },
      ],
    });

    selectSidebarEntry(state, 'f1');

    expect(state.openSelfHostedSubfolder).toHaveBeenCalledWith('/lib/Vacation', 'f1');
    expect(state.setFolderOpen).toHaveBeenCalledWith('f1', true);
  });

  it('selects a plain id (smart collection/album) without an absPath', () => {
    const state = makeState({ viewMode: 'timeline' });

    selectSidebarEntry(state, 'smart-picks');

    expect(state.selectedSourceId()).toBe('smart-picks');
    expect(state.openSelfHostedSubfolder).not.toHaveBeenCalled();
  });
});
