// tool-dock.component.spec.ts — vertical (tablet/desktop) vs horizontal
// (phone) orientation, group/curve wiring, the Crop entry's tool-arming
// semantics (#1813), the Presets panel entry (#1815), and the nine-entry
// Apple-parity shape (#1807 Task 5).
//
// The dock has three entry shapes: `group` entries (arm the group's first
// tool), `panel` entries (Tone Curve, Presets — toggle a floating panel),
// and `tool` entries (Crop — arms ONE SPECIFIC tool without disturbing which
// group's sliders would otherwise show). HSL/B&W/Grade have no dock entry any
// more — they're reached from the Colour/Effects sub-tool row instead (see
// `control-card.component.ts`, `editor-shell-subtool-row.spec.ts`).

import { describe, it, expect, beforeEach } from 'vitest';
import { signal } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';

import { ToolDockComponent } from './tool-dock.component';
import type { ToolGroup, ToolId } from '../../editor/tool-model';
import { LibraryStateService } from '../../state/library-state.service';
import { defaultAdjustmentModel, type AdjustmentModel } from '../../models/adjustment-model';

// No focused asset — `isModified` (the dock's accent-dot predicate) simply
// reads null and returns false; the dot's real behavior is covered by the
// shell-level specs that drive a real AdjustmentModel through the dock
// (e.g. `editor-shell-subtool-row.spec.ts`). This isolated fixture only
// needs the injector satisfied so `ToolDockComponent`'s `LibraryStateService`
// dependency (Step 4) doesn't throw NG0201.
const NO_FOCUS_LIBRARY_STATE = {
  focusedAssetId: () => null,
  adjustmentFor: () => signal(defaultAdjustmentModel()),
};

function render(inputs: {
  activeGroup?: string;
  activeTool?: ToolId | null;
  curveOpen?: boolean;
  presetsOpen?: boolean;
  orientation?: 'vertical' | 'horizontal';
}) {
  // Reset first: the "Apple 9-entry parity" suite calls `render()` twice in
  // one `it` (once per orientation) — TestBed refuses to reconfigure a
  // module it has already instantiated within the same test.
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    imports: [ToolDockComponent],
    providers: [{ provide: LibraryStateService, useValue: NO_FOCUS_LIBRARY_STATE }],
  });
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

function dotFor(fixture: { nativeElement: unknown }, label: string): Element | null {
  return buttonFor(fixture, label).querySelector('.dock-dot');
}

// ── Accent dot (`isModified`, fix round 1) ──────────────────────────────────
// HSL and bwMix have no primary drag-bar field (`fieldFor` returns null for
// both — tool-model.ts:279-286), so a naive "check the tool's one field"
// predicate can never see either tool's 24/8 sub-params go non-default.
// Since neither has its own dock button any more, Colour's dot is the ONLY
// place their modified state can surface — these tests drive a real focused
// asset through the dock and assert the dot actually lights for each shape:
// HSL's hue/sat/lum sub-params, bwMix's gray-mixer weights, the bwMix
// toggle alone (no slider touched), and a Color Grading wheel field that
// isn't the schema-declared primary (`splitToneBalance`).
describe('ToolDockComponent — accent dot (isModified, fix round 1)', () => {
  let fixture: ComponentFixture<ToolDockComponent>;

  function renderModified(patch: Partial<AdjustmentModel>): void {
    const model = signal<AdjustmentModel>({ ...defaultAdjustmentModel(), ...patch });
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      imports: [ToolDockComponent],
      providers: [
        {
          provide: LibraryStateService,
          useValue: {
            focusedAssetId: () => 'a',
            adjustmentFor: () => model,
          },
        },
      ],
    });
    fixture = TestBed.createComponent(ToolDockComponent);
    fixture.componentRef.setInput('activeGroup', 'light');
    fixture.detectChanges();
  }

  it('does NOT render a dot on any group entry at defaults (baseline — has teeth in both directions)', () => {
    renderModified({});
    for (const label of ['Light', 'Color', 'Effects', 'Detail']) {
      expect(dotFor(fixture, label), label).toBeNull();
    }
  });

  it('lights the Colour dot when an HSL sub-param is non-default', () => {
    renderModified({ hueAdjustmentRed: 40 });
    expect(dotFor(fixture, 'Color')).not.toBeNull();
    expect(dotFor(fixture, 'Light')).toBeNull();
    expect(dotFor(fixture, 'Effects')).toBeNull();
  });

  it('lights the Colour dot when a gray-mixer (bwMix) weight is non-default', () => {
    renderModified({ grayMixerRed: -30 });
    expect(dotFor(fixture, 'Color')).not.toBeNull();
  });

  it('lights the Colour dot from the Black & White toggle alone, with every slider at default', () => {
    renderModified({ blackWhite: 'On' });
    expect(dotFor(fixture, 'Color')).not.toBeNull();
  });

  it('lights the Effects dot when a Color Grading wheel field is non-default (not just the primary splitToneBalance)', () => {
    renderModified({ colorGradeMidtoneHue: 50 });
    expect(dotFor(fixture, 'Effects')).not.toBeNull();
    expect(dotFor(fixture, 'Color')).toBeNull();
  });
});

describe('ToolDockComponent — vertical (default) orientation', () => {
  it('defaults to vertical orientation', () => {
    const fixture = render({});
    expect(fixture.componentInstance.orientation()).toBe('vertical');
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

  it('Tone Curve entry fires curvePanelToggle instead of groupChange', () => {
    const fixture = render({});
    let toggled = 0;
    let groupEmitted = false;
    fixture.componentInstance.curvePanelToggle.subscribe(() => toggled++);
    fixture.componentInstance.groupChange.subscribe(() => (groupEmitted = true));
    buttonFor(fixture, 'Tone Curve').click();
    expect(toggled).toBe(1);
    expect(groupEmitted).toBe(false);
  });

  it('disabled entries (Mask/Heal) are non-interactive and show a ticket tooltip', () => {
    const fixture = render({});
    // Disabled entries carry no `aria-label` (kept out of the a11y tree, see
    // the "Apple 9-entry parity" suite), so locate by title instead.
    const maskBtn = nativeEl(fixture).querySelector(
      '.dock-btn[title^="Mask"]',
    ) as HTMLButtonElement | null;
    expect(maskBtn).not.toBeNull();
    expect(maskBtn!.disabled).toBe(true);
    expect(maskBtn!.title).toBe('Mask — coming in #1541');
  });
});

describe('ToolDockComponent — horizontal (phone) orientation', () => {
  it('adds the horizontal host class', () => {
    const fixture = render({ orientation: 'horizontal' });
    expect(nativeEl(fixture).classList.contains('dock-host--horizontal')).toBe(true);
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

  it('Tone Curve entry still fires curvePanelToggle on phone', () => {
    const fixture = render({ orientation: 'horizontal' });
    let toggled = 0;
    fixture.componentInstance.curvePanelToggle.subscribe(() => toggled++);
    buttonFor(fixture, 'Tone Curve').click();
    expect(toggled).toBe(1);
  });

  it('reflects curveOpen as the active state on the Tone Curve entry', () => {
    const fixture = render({ orientation: 'horizontal', curveOpen: true });
    const curveBtn = buttonFor(fixture, 'Tone Curve');
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
    TestBed.configureTestingModule({
      imports: [ToolDockComponent],
      providers: [{ provide: LibraryStateService, useValue: NO_FOCUS_LIBRARY_STATE }],
    });
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
    TestBed.configureTestingModule({
      imports: [ToolDockComponent],
      providers: [{ provide: LibraryStateService, useValue: NO_FOCUS_LIBRARY_STATE }],
    });
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

  it('clicking Tone Curve still emits only curvePanelToggle', () => {
    renderPresets(false, false);
    let presetsToggled = 0;
    let curveToggled = 0;
    fixture.componentInstance.presetsPanelToggle.subscribe(() => presetsToggled++);
    fixture.componentInstance.curvePanelToggle.subscribe(() => curveToggled++);

    button('Tone Curve').click();

    expect(curveToggled).toBe(1);
    expect(presetsToggled).toBe(0);
  });

  it('Presets highlights only from presetsOpen — Tone Curve is independent', () => {
    renderPresets(true, false);
    expect(button('Tone Curve').classList.contains('dock-btn--active')).toBe(true);
    expect(button('Presets').classList.contains('dock-btn--active')).toBe(false);
  });

  it('Tone Curve highlights only from curveOpen — Presets is independent', () => {
    renderPresets(false, true);
    expect(button('Presets').classList.contains('dock-btn--active')).toBe(true);
    expect(button('Tone Curve').classList.contains('dock-btn--active')).toBe(false);
  });
});

describe('Apple 9-entry parity', () => {
  it('renders exactly the nine Apple entries in order, both orientations', () => {
    const expected = [
      'Light',
      'Color',
      'Effects',
      'Detail',
      'Crop',
      'Tone Curve',
      'Presets',
      'Mask',
      'Heal',
    ];
    for (const orientation of ['vertical', 'horizontal'] as const) {
      const fixture = render({ orientation });
      const labels = Array.from(
        (fixture.nativeElement as HTMLElement).querySelectorAll('.dock-btn .dock-label'),
      ).map((n) => n.textContent!.trim());
      expect(labels, orientation).toEqual(expected);
    }
  });

  it('no longer offers HSL, B&W, Grade or Optics buttons', () => {
    const fixture = render({});
    const labels = Array.from(
      (fixture.nativeElement as HTMLElement).querySelectorAll('.dock-btn'),
    ).map((n) => n.getAttribute('aria-label'));
    for (const gone of ['HSL', 'B&W', 'Grade', 'Optics']) {
      expect(labels).not.toContain(gone);
    }
  });

  it('draws a divider before Crop', () => {
    const fixture = render({});
    const el = fixture.nativeElement as HTMLElement;
    const nodes = Array.from(el.querySelectorAll('.dock-divider, .dock-btn'));
    const dividerIndex = nodes.findIndex((n) => n.classList.contains('dock-divider'));
    const cropIndex = nodes.findIndex((n) => n.getAttribute('aria-label') === 'Crop');
    expect(dividerIndex).toBeGreaterThan(-1);
    expect(dividerIndex).toBe(cropIndex - 1);
  });

  it('keeps disabled placeholders out of the accessibility tree', () => {
    const fixture = render({});
    const mask = (fixture.nativeElement as HTMLElement).querySelector('[aria-label="Mask"]');
    expect(mask).toBeNull();
    const placeholders = (fixture.nativeElement as HTMLElement).querySelectorAll(
      '.dock-btn--disabled[aria-hidden="true"]',
    );
    expect(placeholders.length).toBe(2);
  });
});
