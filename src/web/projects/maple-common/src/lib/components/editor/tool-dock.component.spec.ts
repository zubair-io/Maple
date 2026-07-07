// tool-dock.component.spec.ts — Crop entry semantics (#1813).
//
// The dock previously only had `group` entries (arm the group's first tool)
// and the `panel` entry (Curve, toggles a floating panel). Crop needed a
// third shape: arm ONE SPECIFIC tool without disturbing which group's
// sliders would otherwise show. This spec locks down:
//   - the Crop entry emits `toolChange('crop')`, not `groupChange`
//   - Crop's own highlight tracks `activeTool`, not `activeGroup`
//   - arming Crop (which lives in the `detail` group) must NOT also
//     highlight the Detail entry — the two are visually distinct.

import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { describe, it, expect, beforeEach } from 'vitest';
import { ToolDockComponent } from './tool-dock.component';
import type { ToolGroup, ToolId } from '../../editor/tool-model';

describe('ToolDockComponent — Crop entry (#1813)', () => {
  let fixture: ComponentFixture<ToolDockComponent>;

  function render(activeGroup: ToolGroup, activeTool: ToolId | null): void {
    fixture = TestBed.createComponent(ToolDockComponent);
    fixture.componentRef.setInput('activeGroup', activeGroup);
    fixture.componentRef.setInput('activeTool', activeTool);
    fixture.detectChanges();
  }

  function button(label: string): HTMLButtonElement {
    const btn = fixture.nativeElement.querySelector(
      `button[aria-label="${label}"]`,
    ) as HTMLButtonElement | null;
    expect(btn).not.toBeNull();
    return btn!;
  }

  beforeEach(() => {
    TestBed.configureTestingModule({ imports: [ToolDockComponent] });
  });

  it('renders an enabled Crop entry', () => {
    render('light', 'exposure');
    const btn = button('Crop');
    expect(btn.disabled).toBe(false);
  });

  it('clicking Crop emits toolChange("crop"), not groupChange', () => {
    render('light', 'exposure');
    let toolEmitted: ToolId | null = null;
    let groupEmitted: ToolGroup | null = null;
    fixture.componentInstance.toolChange.subscribe((t) => (toolEmitted = t));
    fixture.componentInstance.groupChange.subscribe((g) => (groupEmitted = g));

    button('Crop').click();

    expect(toolEmitted).toBe('crop');
    expect(groupEmitted).toBeNull();
  });

  it('Crop highlights only when armedTool is crop — Detail does not also highlight', () => {
    render('detail', 'crop');
    expect(button('Crop').classList.contains('dock-btn--active')).toBe(true);
    expect(button('Detail').classList.contains('dock-btn--active')).toBe(false);
  });

  it('Detail highlights normally when a detail-group tool other than crop is armed', () => {
    render('detail', 'sharpen');
    expect(button('Detail').classList.contains('dock-btn--active')).toBe(true);
    expect(button('Crop').classList.contains('dock-btn--active')).toBe(false);
  });

  it('neither Crop nor Detail highlight when a different group is active', () => {
    render('light', 'exposure');
    expect(button('Crop').classList.contains('dock-btn--active')).toBe(false);
    expect(button('Detail').classList.contains('dock-btn--active')).toBe(false);
  });
});

// ── Presets entry (#1815) ────────────────────────────────────────────────
// Presets is a second `panel: true` entry alongside Curve — this locks down
// that generalizing the dock's panel mechanism (previously hardcoded to
// `entry.id === 'curve'`) didn't cross-wire the two panels' toggle outputs
// or active-highlight state.
describe('ToolDockComponent — Presets entry (#1815)', () => {
  let fixture: ComponentFixture<ToolDockComponent>;

  function render(curveOpen: boolean, presetsOpen: boolean): void {
    fixture = TestBed.createComponent(ToolDockComponent);
    fixture.componentRef.setInput('activeGroup', 'light');
    fixture.componentRef.setInput('activeTool', 'exposure');
    fixture.componentRef.setInput('curveOpen', curveOpen);
    fixture.componentRef.setInput('presetsOpen', presetsOpen);
    fixture.detectChanges();
  }

  function button(label: string): HTMLButtonElement {
    const btn = fixture.nativeElement.querySelector(
      `button[aria-label="${label}"]`,
    ) as HTMLButtonElement | null;
    expect(btn).not.toBeNull();
    return btn!;
  }

  beforeEach(() => {
    TestBed.configureTestingModule({ imports: [ToolDockComponent] });
  });

  it('renders an enabled Presets entry', () => {
    render(false, false);
    expect(button('Presets').disabled).toBe(false);
  });

  it('clicking Presets emits presetsPanelToggle, not curvePanelToggle', () => {
    render(false, false);
    let presetsToggled = 0;
    let curveToggled = 0;
    fixture.componentInstance.presetsPanelToggle.subscribe(() => presetsToggled++);
    fixture.componentInstance.curvePanelToggle.subscribe(() => curveToggled++);

    button('Presets').click();

    expect(presetsToggled).toBe(1);
    expect(curveToggled).toBe(0);
  });

  it('clicking Curve still emits only curvePanelToggle', () => {
    render(false, false);
    let presetsToggled = 0;
    let curveToggled = 0;
    fixture.componentInstance.presetsPanelToggle.subscribe(() => presetsToggled++);
    fixture.componentInstance.curvePanelToggle.subscribe(() => curveToggled++);

    button('Curve').click();

    expect(curveToggled).toBe(1);
    expect(presetsToggled).toBe(0);
  });

  it('Presets highlights only from presetsOpen — Curve is independent', () => {
    render(true, false);
    expect(button('Curve').classList.contains('dock-btn--active')).toBe(true);
    expect(button('Presets').classList.contains('dock-btn--active')).toBe(false);
  });

  it('Curve highlights only from curveOpen — Presets is independent', () => {
    render(false, true);
    expect(button('Presets').classList.contains('dock-btn--active')).toBe(true);
    expect(button('Curve').classList.contains('dock-btn--active')).toBe(false);
  });
});
