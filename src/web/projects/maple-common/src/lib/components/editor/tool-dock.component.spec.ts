// tool-dock.component.spec.ts — vertical (tablet/desktop) vs horizontal
// (phone, #1807) orientation, entry filtering, group/curve wiring, the Crop
// entry's tool-arming semantics (#1813), and the Presets panel entry (#1815).
//
// The dock has three entry shapes: `group` entries (arm the group's first
// tool), `panel` entries (Curve, Presets — toggle a floating panel), and
// `tool` entries (Crop, HSL — arm ONE SPECIFIC tool without disturbing which
// group's sliders would otherwise show). Crop has both a vertical-only and a
// horizontal-only entry (same `tool: 'crop'`) purely for dock ordering.

import { describe, it, expect, beforeEach } from 'vitest';
import { TestBed, type ComponentFixture } from '@angular/core/testing';

import { ToolDockComponent } from './tool-dock.component';
import type { ToolGroup, ToolId } from '../../editor/tool-model';

function render(inputs: {
  activeGroup?: string;
  activeTool?: ToolId | null;
  curveOpen?: boolean;
  presetsOpen?: boolean;
  orientation?: 'vertical' | 'horizontal';
  blackWhiteOn?: boolean;
}) {
  TestBed.configureTestingModule({ imports: [ToolDockComponent] });
  const fixture = TestBed.createComponent(ToolDockComponent);
  fixture.componentRef.setInput('activeGroup', inputs.activeGroup ?? 'light');
  if (inputs.activeTool !== undefined) {
    fixture.componentRef.setInput('activeTool', inputs.activeTool);
  }
  if (inputs.curveOpen !== undefined) {
    fixture.componentRef.setInput('curveOpen', inputs.curveOpen);
  }
  if (inputs.presetsOpen !== undefined) {
    fixture.componentRef.setInput('presetsOpen', inputs.presetsOpen);
  }
  if (inputs.orientation !== undefined) {
    fixture.componentRef.setInput('orientation', inputs.orientation);
  }
  if (inputs.blackWhiteOn !== undefined) {
    fixture.componentRef.setInput('blackWhiteOn', inputs.blackWhiteOn);
  }
  fixture.detectChanges();
  return fixture;
}

function nativeEl(fixture: { nativeElement: unknown }): HTMLElement {
  return fixture.nativeElement as HTMLElement;
}

function buttons(fixture: { nativeElement: unknown }): HTMLButtonElement[] {
  return Array.from(nativeEl(fixture).querySelectorAll<HTMLButtonElement>('button.dock-btn'));
}

function buttonFor(fixture: { nativeElement: unknown }, label: string): HTMLButtonElement {
  return buttons(fixture).find((b) => b.getAttribute('aria-label') === label)!;
}

describe('ToolDockComponent — vertical (default) orientation', () => {
  it('defaults to vertical orientation', () => {
    const fixture = render({});
    expect(fixture.componentInstance.orientation()).toBe('vertical');
  });

  it('renders the 13 tablet/desktop entries, including Crop/HSL/B&W/Grade/Presets', () => {
    const fixture = render({});
    const labels = buttons(fixture).map((b) => b.getAttribute('aria-label'));
    expect(labels).toEqual([
      'Light',
      'Color',
      'HSL',
      'B&W',
      'Curve',
      'Grade',
      'Effects',
      'Detail',
      'Crop',
      'Presets',
      'Optics',
      'Mask',
      'Heal',
    ]);
  });

  it('hides the HSL entry (only) while Black & White is On (#276)', () => {
    const fixture = render({ blackWhiteOn: true });
    const labels = buttons(fixture).map((b) => b.getAttribute('aria-label'));
    expect(labels).not.toContain('HSL');
    expect(labels).toContain('B&W');
    expect(labels).toEqual([
      'Light',
      'Color',
      'B&W',
      'Curve',
      'Grade',
      'Effects',
      'Detail',
      'Crop',
      'Presets',
      'Optics',
      'Mask',
      'Heal',
    ]);
  });

  it('HSL reappears once Black & White is switched back Off', () => {
    const fixture = render({ blackWhiteOn: true });
    expect(
      buttons(fixture)
        .map((b) => b.getAttribute('aria-label'))
        .includes('HSL'),
    ).toBe(false);
    fixture.componentRef.setInput('blackWhiteOn', false);
    fixture.detectChanges();
    expect(
      buttons(fixture)
        .map((b) => b.getAttribute('aria-label'))
        .includes('HSL'),
    ).toBe(true);
  });

  it('B&W entry arms the bwMix tool directly', () => {
    const fixture = render({});
    let toolEmitted: ToolId | null = null;
    fixture.componentInstance.toolChange.subscribe((t) => (toolEmitted = t));
    buttonFor(fixture, 'B&W').click();
    expect(toolEmitted).toBe('bwMix');
  });

  it('B&W entry highlights only when bwMix is armed', () => {
    const fixture = render({ activeTool: 'bwMix', activeGroup: 'color' });
    expect(buttonFor(fixture, 'B&W').classList.contains('dock-btn--active')).toBe(true);
    expect(buttonFor(fixture, 'Color').classList.contains('dock-btn--active')).toBe(false);
  });

  it('does not add the horizontal host class', () => {
    const fixture = render({});
    expect(nativeEl(fixture).classList.contains('dock-host--horizontal')).toBe(false);
  });

  it('marks the active group entry active and emits groupChange on click', () => {
    const fixture = render({ activeGroup: 'color' });
    const colorBtn = buttonFor(fixture, 'Color');
    expect(colorBtn.classList.contains('dock-btn--active')).toBe(true);

    let emitted: string | undefined;
    fixture.componentInstance.groupChange.subscribe((g) => (emitted = g));
    buttonFor(fixture, 'Detail').click();
    expect(emitted).toBe('detail');
  });

  it('Curve entry fires curvePanelToggle instead of groupChange', () => {
    const fixture = render({});
    let toggled = 0;
    let groupEmitted = false;
    fixture.componentInstance.curvePanelToggle.subscribe(() => toggled++);
    fixture.componentInstance.groupChange.subscribe(() => (groupEmitted = true));
    buttonFor(fixture, 'Curve').click();
    expect(toggled).toBe(1);
    expect(groupEmitted).toBe(false);
  });

  it('disabled entries (Optics/Mask/Heal) are non-interactive and show a ticket tooltip', () => {
    const fixture = render({});
    const opticsBtn = buttonFor(fixture, 'Optics');
    expect(opticsBtn.disabled).toBe(true);
    expect(opticsBtn.title).toBe('Optics — coming in #1534');
  });
});

describe('ToolDockComponent — horizontal (phone) orientation', () => {
  it('adds the horizontal host class', () => {
    const fixture = render({ orientation: 'horizontal' });
    expect(nativeEl(fixture).classList.contains('dock-host--horizontal')).toBe(true);
  });

  it('renders exactly Light/Color/HSL/B&W/Curve/Grade/Effects/Detail/Presets/Crop, excluding Optics/Mask/Heal', () => {
    const fixture = render({ orientation: 'horizontal' });
    const labels = buttons(fixture).map((b) => b.getAttribute('aria-label'));
    expect(labels).toEqual([
      'Light',
      'Color',
      'HSL',
      'B&W',
      'Curve',
      'Grade',
      'Effects',
      'Detail',
      'Presets',
      'Crop',
    ]);
  });

  it('Crop is enabled and arms the crop tool (#1813 wired it; no longer a #1807 placeholder)', () => {
    const fixture = render({ orientation: 'horizontal' });
    const cropBtn = buttonFor(fixture, 'Crop');
    expect(cropBtn.disabled).toBe(false);

    let toolEmitted: ToolId | null = null;
    fixture.componentInstance.toolChange.subscribe((t) => (toolEmitted = t));
    cropBtn.click();
    expect(toolEmitted).toBe('crop');
  });

  it('tapping a group icon emits groupChange (shell arms the group + opens the flyout)', () => {
    const fixture = render({ orientation: 'horizontal', activeGroup: 'light' });
    let emitted: string | undefined;
    fixture.componentInstance.groupChange.subscribe((g) => (emitted = g));
    buttonFor(fixture, 'Effects').click();
    expect(emitted).toBe('effects');
  });

  it('Curve entry still fires curvePanelToggle on phone', () => {
    const fixture = render({ orientation: 'horizontal' });
    let toggled = 0;
    fixture.componentInstance.curvePanelToggle.subscribe(() => toggled++);
    buttonFor(fixture, 'Curve').click();
    expect(toggled).toBe(1);
  });

  it('reflects curveOpen as the active state on the Curve entry', () => {
    const fixture = render({ orientation: 'horizontal', curveOpen: true });
    const curveBtn = buttonFor(fixture, 'Curve');
    expect(curveBtn.classList.contains('dock-btn--active')).toBe(true);
  });
});

// ── Crop entry tool-arming semantics (#1813) ────────────────────────────────
// The Crop entry arms ONE SPECIFIC tool without disturbing which group's
// sliders would otherwise show. This locks down:
//   - the Crop entry emits `toolChange('crop')`, not `groupChange`
//   - Crop's own highlight tracks `activeTool`, not `activeGroup`
//   - arming Crop (which lives in the `detail` group) must NOT also
//     highlight the Detail entry — the two are visually distinct.
describe('ToolDockComponent — Crop entry (#1813)', () => {
  let fixture: ComponentFixture<ToolDockComponent>;

  function renderCrop(activeGroup: ToolGroup, activeTool: ToolId | null): void {
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
    renderCrop('light', 'exposure');
    const btn = button('Crop');
    expect(btn.disabled).toBe(false);
  });

  it('clicking Crop emits toolChange("crop"), not groupChange', () => {
    renderCrop('light', 'exposure');
    let toolEmitted: ToolId | null = null;
    let groupEmitted: ToolGroup | null = null;
    fixture.componentInstance.toolChange.subscribe((t) => (toolEmitted = t));
    fixture.componentInstance.groupChange.subscribe((g) => (groupEmitted = g));

    button('Crop').click();

    expect(toolEmitted).toBe('crop');
    expect(groupEmitted).toBeNull();
  });

  it('Crop highlights only when armedTool is crop — Detail does not also highlight', () => {
    renderCrop('detail', 'crop');
    expect(button('Crop').classList.contains('dock-btn--active')).toBe(true);
    expect(button('Detail').classList.contains('dock-btn--active')).toBe(false);
  });

  it('Detail highlights normally when a detail-group tool other than crop is armed', () => {
    renderCrop('detail', 'sharpen');
    expect(button('Detail').classList.contains('dock-btn--active')).toBe(true);
    expect(button('Crop').classList.contains('dock-btn--active')).toBe(false);
  });

  it('neither Crop nor Detail highlight when a different group is active', () => {
    renderCrop('light', 'exposure');
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

  function renderPresets(curveOpen: boolean, presetsOpen: boolean): void {
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
    renderPresets(false, false);
    expect(button('Presets').disabled).toBe(false);
  });

  it('clicking Presets emits presetsPanelToggle, not curvePanelToggle', () => {
    renderPresets(false, false);
    let presetsToggled = 0;
    let curveToggled = 0;
    fixture.componentInstance.presetsPanelToggle.subscribe(() => presetsToggled++);
    fixture.componentInstance.curvePanelToggle.subscribe(() => curveToggled++);

    button('Presets').click();

    expect(presetsToggled).toBe(1);
    expect(curveToggled).toBe(0);
  });

  it('clicking Curve still emits only curvePanelToggle', () => {
    renderPresets(false, false);
    let presetsToggled = 0;
    let curveToggled = 0;
    fixture.componentInstance.presetsPanelToggle.subscribe(() => presetsToggled++);
    fixture.componentInstance.curvePanelToggle.subscribe(() => curveToggled++);

    button('Curve').click();

    expect(curveToggled).toBe(1);
    expect(presetsToggled).toBe(0);
  });

  it('Presets highlights only from presetsOpen — Curve is independent', () => {
    renderPresets(true, false);
    expect(button('Curve').classList.contains('dock-btn--active')).toBe(true);
    expect(button('Presets').classList.contains('dock-btn--active')).toBe(false);
  });

  it('Curve highlights only from curveOpen — Presets is independent', () => {
    renderPresets(false, true);
    expect(button('Presets').classList.contains('dock-btn--active')).toBe(true);
    expect(button('Curve').classList.contains('dock-btn--active')).toBe(false);
  });
});
