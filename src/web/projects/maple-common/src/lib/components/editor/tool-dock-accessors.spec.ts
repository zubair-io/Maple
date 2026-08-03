// tool-dock-accessors.spec.ts — unit tests for the view-model accessors
// (titleFor, ariaHiddenFor, tabIndexFor, ariaLabelFor, ariaCurrentFor,
// ariaPressedFor, iconColor) that back the circle+label+dot dock markup
// (Apple parity, ToolDock.swift). These were pulled out of
// tool-dock.component.html's inline ternaries — the fallow complexity gate
// flagged the template once the circle+label+modified-dot rewrite added a
// branch per attribute — so the a11y attribute logic is directly testable
// rather than only reachable through DOM assertions. Split into its own
// file (not appended to tool-dock.component.spec.ts) to keep both files
// under the per-file line budget (#2311).
//
// Kept separate from tool-dock.component.spec.ts's DOM-level specs, which
// already confirm the template wires these methods in correctly end to end.

import { describe, it, expect } from 'vitest';
import { TestBed, type ComponentFixture } from '@angular/core/testing';

import { ToolDockComponent, type DockEntry } from './tool-dock.component';
import type { ToolGroup, ToolId } from '../../editor/tool-model';
import { LibraryStateService } from '../../state/library-state.service';
import { defaultAdjustmentModel } from '../../models/adjustment-model';
import { signal } from '@angular/core';

const NO_FOCUS_LIBRARY_STATE = {
  focusedAssetId: () => null,
  adjustmentFor: () => signal(defaultAdjustmentModel()),
};

const groupEntry: DockEntry = {
  id: 'light',
  icon: 'tool-exposure',
  label: 'Light',
  group: 'light',
};
const toolEntry: DockEntry = { id: 'crop', icon: 'tool-crop', label: 'Crop', tool: 'crop' };
const panelEntry: DockEntry = {
  id: 'curve',
  icon: 'tool-contrast',
  label: 'Tone Curve',
  panel: true,
};
const disabledEntry: DockEntry = {
  id: 'mask',
  icon: 'tool-dehaze',
  label: 'Mask',
  disabled: true,
  ticket: '#1541',
};

describe('ToolDockComponent — view-model accessors', () => {
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

  it('titleFor: plain label enabled, label + ticket disabled', () => {
    renderFor('light', null);
    expect(fixture.componentInstance.titleFor(groupEntry)).toBe('Light');
    expect(fixture.componentInstance.titleFor(disabledEntry)).toBe('Mask — coming in #1541');
  });

  it('enabled entries stay in the accessibility tree (not hidden, tabbable, labeled)', () => {
    renderFor('light', null);
    const c = fixture.componentInstance;
    expect(c.ariaHiddenFor(groupEntry)).toBeNull();
    expect(c.tabIndexFor(groupEntry)).toBeNull();
    expect(c.ariaLabelFor(groupEntry)).toBe('Light');
  });

  it('disabled entries are hidden, untabbable, and unlabeled', () => {
    renderFor('light', null);
    const c = fixture.componentInstance;
    expect(c.ariaHiddenFor(disabledEntry)).toBe('true');
    expect(c.tabIndexFor(disabledEntry)).toBe(-1);
    expect(c.ariaLabelFor(disabledEntry)).toBeNull();
  });

  it('ariaCurrentFor: "page" for an active group entry, null when inactive', () => {
    renderFor('light', null);
    expect(fixture.componentInstance.ariaCurrentFor(groupEntry)).toBe('page');
    renderFor('color', null);
    expect(fixture.componentInstance.ariaCurrentFor(groupEntry)).toBeNull();
  });

  it('ariaCurrentFor: "page" for an active tool entry too', () => {
    renderFor('detail', 'crop');
    expect(fixture.componentInstance.ariaCurrentFor(toolEntry)).toBe('page');
  });

  it('ariaCurrentFor: never set for a panel entry, even while its panel is open', () => {
    renderFor('light', null, true);
    expect(fixture.componentInstance.ariaCurrentFor(panelEntry)).toBeNull();
  });

  it("ariaPressedFor: reflects a panel entry's open state, null for group/tool entries", () => {
    renderFor('light', null, true);
    expect(fixture.componentInstance.ariaPressedFor(panelEntry)).toBe(true);
    renderFor('light', null, false);
    const c = fixture.componentInstance;
    expect(c.ariaPressedFor(panelEntry)).toBe(false);
    expect(c.ariaPressedFor(groupEntry)).toBeNull();
    expect(c.ariaPressedFor(toolEntry)).toBeNull();
  });

  it('iconColor: accent when active, dimmed when disabled, default text otherwise', () => {
    renderFor('light', null);
    expect(fixture.componentInstance.iconColor(groupEntry)).toBe('var(--pro-accent)');
    expect(fixture.componentInstance.iconColor(disabledEntry)).toBe('var(--pro-text-dim)');
    renderFor('color', null);
    expect(fixture.componentInstance.iconColor(groupEntry)).toBe('var(--pro-text)');
  });
});
