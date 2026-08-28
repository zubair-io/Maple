// tool-dock-accessors.spec.ts — unit tests for `dockEntries()`, the
// `MuiToolDockEntry[]` view-model `ToolDockComponent` builds for
// `<mui-tool-dock>` (title, disabled, ariaHidden, selected, modified per
// entry). Pulled out of tool-dock.component.spec.ts's DOM-level specs to
// keep both files under the per-file line budget (#2311) — same split as
// before #3046's chrome swap, just re-targeted at the entries computed
// signal instead of the retired per-attribute ternary methods
// (titleFor/ariaHiddenFor/etc. moved into `dockEntries()` itself).
//
// Kept separate from tool-dock.component.spec.ts's DOM-level specs, which
// already confirm the template wires this computed signal into
// `<mui-tool-dock>` correctly end to end.

import { describe, it, expect } from 'vitest';
import { TestBed, type ComponentFixture } from '@angular/core/testing';

import { ToolDockComponent } from './tool-dock.component';
import type { MuiToolDockItem } from '../../ui/tool-dock/mui-tool-dock.component';
import type { ToolGroup, ToolId } from '../../editor/tool-model';
import { LibraryStateService } from '../../state/library-state.service';
import { defaultAdjustmentModel } from '../../models/adjustment-model';
import { signal } from '@angular/core';

const NO_FOCUS_LIBRARY_STATE = {
  focusedAssetId: () => null,
  adjustmentFor: () => signal(defaultAdjustmentModel()),
};

function itemFor(entries: ComponentFixture<ToolDockComponent>, id: string): MuiToolDockItem {
  const found = entries.componentInstance
    .dockEntries()
    .find((e): e is MuiToolDockItem => 'id' in e && e.id === id);
  expect(found, id).toBeDefined();
  return found!;
}

describe('ToolDockComponent — dockEntries() view-model', () => {
  let fixture: ComponentFixture<ToolDockComponent>;

  function renderFor(activeGroup: ToolGroup, activeTool: ToolId | null, curveOpen = false): void {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      imports: [ToolDockComponent],
      providers: [{ provide: LibraryStateService, useValue: NO_FOCUS_LIBRARY_STATE }],
    });
    fixture = TestBed.createComponent(ToolDockComponent);
    fixture.componentRef.setInput('activeGroup', activeGroup);
    fixture.componentRef.setInput('activeTool', activeTool);
    fixture.componentRef.setInput('curveOpen', curveOpen);
    fixture.detectChanges();
  }

  it('title: plain label enabled, label + ticket disabled', () => {
    renderFor('light', null);
    expect(itemFor(fixture, 'light').title).toBe('Light');
    expect(itemFor(fixture, 'mask').title).toBe('Mask — coming in #1541');
  });

  it('enabled entries stay in the accessibility tree (not hidden, labeled)', () => {
    renderFor('light', null);
    const item = itemFor(fixture, 'light');
    expect(item.ariaHidden).toBe(false);
    expect(item.disabled).toBeFalsy();
    expect(item.label).toBe('Light');
  });

  it('disabled entries are hidden from the a11y tree', () => {
    renderFor('light', null);
    const item = itemFor(fixture, 'mask');
    expect(item.ariaHidden).toBe(true);
    expect(item.disabled).toBe(true);
  });

  it('a group entry is selected only while its group is active and no dock tool is armed', () => {
    renderFor('light', null);
    expect(itemFor(fixture, 'light').selected).toBe(true);
    expect(itemFor(fixture, 'color').selected).toBe(false);
  });

  it('a panel entry is selected from curveOpen, independent of the active group', () => {
    renderFor('light', null, true);
    expect(itemFor(fixture, 'curve').selected).toBe(true);
    expect(itemFor(fixture, 'light').selected).toBe(true);
  });

  it('marks panel entries with panel: true so the dock treats them as toggles', () => {
    renderFor('light', null);
    expect(itemFor(fixture, 'curve').panel).toBe(true);
    expect(itemFor(fixture, 'presets').panel).toBe(true);
    expect(itemFor(fixture, 'light').panel).toBeFalsy();
  });
});
