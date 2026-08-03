// control-card.component.spec.ts — flyout header parity (accent group title,
// no chip row, no grab handle). The card renders identically on every
// breakpoint (#1807 Task 5 retired the phone-only close button and `closed`
// input — the card is always visible now, tablet/desktop and phone alike).

import { describe, it, expect, vi } from 'vitest';
import { TestBed } from '@angular/core/testing';
import type { ComponentFixture } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { signal } from '@angular/core';

import { ControlCardComponent } from './control-card.component';
import { LivingSliderComponent } from '../develop/living-slider.component';
import { EditorStateService } from '../../editor/editor-state.service';
import { LibraryStateService } from '../../state/library-state.service';
import { RawPipelineService } from '../../raw-pipeline/raw-pipeline.service';
import { makeLibraryStub } from '../../editor/editor-state.test-helpers';
import { defaultAdjustmentModel } from '../../models/adjustment-model';

function render(
  inputs: {
    activeGroup?: string;
    activeTool?: string | null;
    blackWhiteOn?: boolean;
  } = {},
): {
  fixture: ComponentFixture<ControlCardComponent>;
  updateAdjustment: ReturnType<typeof vi.fn>;
  commit: ReturnType<typeof vi.fn>;
  haptic: ReturnType<typeof vi.fn>;
  // Convenience passthroughs so callers that only need the rendered DOM or
  // the component instance (the colour sub-tool row tests below) don't have
  // to destructure `.fixture` first.
  nativeElement: HTMLElement;
  componentInstance: ControlCardComponent;
} {
  // Some callers (the colour sub-tool row tests below) render twice within a
  // single `it()` to compare two states — TestBed refuses a second
  // `configureTestingModule` once a prior call has instantiated a component,
  // so each `render()` starts from a clean module.
  TestBed.resetTestingModule();
  const focusedAssetId = signal<string | null>('asset-1');
  const adjustmentFor = vi.fn(() => signal(defaultAdjustmentModel()));
  const updateAdjustment = vi.fn();
  const commit = vi.fn();
  const haptic = vi.fn();
  // onSliderChange arms the dragged tool (mirrors Apple's LivingSliderRow) —
  // stub both halves of that read/write pair so a valueChange tick doesn't
  // throw on a mock that pre-dates this exercising it.
  const armedTool = vi.fn(() => 'brightness');
  const armTool = vi.fn();

  TestBed.configureTestingModule({
    imports: [ControlCardComponent],
    providers: [
      { provide: EditorStateService, useValue: { commit, haptic, armedTool, armTool } },
      {
        provide: LibraryStateService,
        useValue: { focusedAssetId, adjustmentFor, updateAdjustment },
      },
    ],
  });

  const fixture = TestBed.createComponent(ControlCardComponent);
  fixture.componentRef.setInput('activeGroup', inputs.activeGroup ?? 'light');
  if (inputs.activeTool !== undefined)
    fixture.componentRef.setInput('activeTool', inputs.activeTool);
  if (inputs.blackWhiteOn !== undefined)
    fixture.componentRef.setInput('blackWhiteOn', inputs.blackWhiteOn);
  fixture.detectChanges();
  return {
    fixture,
    updateAdjustment,
    commit,
    haptic,
    nativeElement: fixture.nativeElement,
    componentInstance: fixture.componentInstance,
  };
}

describe('ControlCardComponent — always visible, no closeable state (#1807 Task 5)', () => {
  it('always renders the card', () => {
    const { fixture } = render();
    expect(fixture.nativeElement.querySelector('.card')).toBeTruthy();
  });

  it('suppresses the group-chips row and shows the active group title instead', () => {
    const { fixture } = render({ activeGroup: 'color' });
    expect(fixture.nativeElement.querySelector('.group-chips')).toBeFalsy();
    const title = fixture.nativeElement.querySelector('.group-title');
    expect(title?.textContent?.trim()).toBe('COLOR');
  });

  it('renders the card with sliders', () => {
    const { fixture } = render({ activeGroup: 'light' });
    expect(fixture.nativeElement.querySelector('.card')).toBeTruthy();
    expect(fixture.nativeElement.querySelector('.slider-grid')).toBeTruthy();
    expect(fixture.nativeElement.querySelectorAll('pro-living-slider').length).toBeGreaterThan(0);
  });

  it('exposes the reset button', () => {
    const { fixture } = render();
    expect(fixture.nativeElement.querySelector('.reset-btn')).toBeTruthy();
  });
});

// #2411 — pointer-driven slider edits left Undo permanently disabled: every
// `valueChange` tick wrote straight through `LibraryStateService`, and
// nothing ever called `EditorStateService.commit()` to open an undo entry
// (the sibling `onSliderReset` / `resetGroup` handlers already did). A drag
// still must not push one undo entry PER TICK — `LivingSliderComponent`
// emits `valueChange` on every pointermove — so the fix hangs the commit off
// a `dragStart` gesture-boundary output instead of off `valueChange` itself.
describe('ControlCardComponent — pointer/keyboard slider gestures push undo entries (#2411)', () => {
  function firstSlider(fixture: ComponentFixture<ControlCardComponent>): LivingSliderComponent {
    const debugEl = fixture.debugElement.query(By.directive(LivingSliderComponent));
    return debugEl.componentInstance as LivingSliderComponent;
  }

  it('a drag gesture (dragStart then many valueChange ticks) commits exactly once, before the first update', () => {
    const { fixture, updateAdjustment, commit } = render({ activeGroup: 'light' });
    const order: string[] = [];
    commit.mockImplementation(() => order.push('commit'));
    updateAdjustment.mockImplementation(() => order.push('update'));

    const exposureSlider = firstSlider(fixture);
    exposureSlider.dragStart.emit();
    for (let i = 1; i <= 12; i++) exposureSlider.valueChange.emit(i * 0.1);

    expect(commit).toHaveBeenCalledTimes(1);
    expect(updateAdjustment).toHaveBeenCalledTimes(12);
    expect(order[0]).toBe('commit');
    expect(order.slice(1)).toEqual(Array(12).fill('update'));
  });

  it('two separate gestures push two commits — one per gesture, not per tick', () => {
    const { fixture, updateAdjustment, commit } = render({ activeGroup: 'light' });
    const exposureSlider = firstSlider(fixture);

    exposureSlider.dragStart.emit();
    exposureSlider.valueChange.emit(0.3);
    exposureSlider.valueChange.emit(0.5);
    exposureSlider.dragEnd.emit();

    exposureSlider.dragStart.emit();
    exposureSlider.valueChange.emit(0.8);
    exposureSlider.dragEnd.emit();

    expect(commit).toHaveBeenCalledTimes(2);
    expect(updateAdjustment).toHaveBeenCalledTimes(3);
  });

  it('Undo after a drag restores the pre-gesture value (real EditorStateService)', () => {
    const lib = makeLibraryStub();
    const focusedAssetId = signal<string | null>('asset-1');

    TestBed.configureTestingModule({
      imports: [ControlCardComponent],
      providers: [
        { provide: LibraryStateService, useValue: { ...lib, focusedAssetId } },
        { provide: RawPipelineService, useValue: {} },
      ],
    });
    const editorState = TestBed.inject(EditorStateService);
    editorState.bind('asset-1');

    const fixture = TestBed.createComponent(ControlCardComponent);
    fixture.componentRef.setInput('activeGroup', 'light');
    fixture.detectChanges();

    expect(lib.adjustmentFor('asset-1')().exposure).toBe(0);

    const exposureSlider = firstSlider(fixture);
    exposureSlider.dragStart.emit();
    for (let i = 1; i <= 5; i++) exposureSlider.valueChange.emit(i);
    expect(lib.adjustmentFor('asset-1')().exposure).toBe(5);
    exposureSlider.dragEnd.emit();

    expect(editorState.canUndo()).toBe(true);
    editorState.undo();
    expect(lib.adjustmentFor('asset-1')().exposure).toBe(0);
  });
});

describe('flyout header (FlyoutSliderPanel parity)', () => {
  it('shows the accent group title and no group-chip row', () => {
    const { fixture } = render({ activeGroup: 'color' });
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('.group-title')?.textContent?.trim()).toBe('COLOR');
    expect(el.querySelector('.group-chips')).toBeNull();
    expect(el.querySelector('.grab-handle')).toBeNull();
  });
});

// Group-parameterised (#1807 Task 4 review correction): Colour Grading's
// real group is Effects (`TOOLS_IN_GROUP.effects`), so a single Colour-only
// row containing Grade would hide itself the instant it's armed. Colour
// gets `Basic · HSL · B&W`, Effects gets `Basic · Grade`, Light/Detail get
// no row.
describe('sub-tool row', () => {
  it('renders Basic/HSL/B&W for the colour group, Basic/Grade for effects, and nothing for light/detail', () => {
    const colour = render({ activeGroup: 'color' });
    const colourChips = Array.from(
      (colour.nativeElement as HTMLElement).querySelectorAll('.subtool-chip'),
    ).map((n) => n.textContent!.trim());
    expect(colourChips).toEqual(['Basic', 'HSL', 'B&W']);

    const effects = render({ activeGroup: 'effects' });
    const effectsChips = Array.from(
      (effects.nativeElement as HTMLElement).querySelectorAll('.subtool-chip'),
    ).map((n) => n.textContent!.trim());
    expect(effectsChips).toEqual(['Basic', 'Grade']);

    const light = render({ activeGroup: 'light' });
    expect((light.nativeElement as HTMLElement).querySelector('.subtool-row')).toBeNull();

    const detail = render({ activeGroup: 'detail' });
    expect((detail.nativeElement as HTMLElement).querySelector('.subtool-row')).toBeNull();
  });

  // Restores #276's dock-hiding behaviour in its new home: HSL's 24 sliders
  // are inert while Black & White is On (it drives the same 8-band Oklab
  // stage instead), so the chip that would arm them into visible existence
  // must not be offered (review finding — before this, `SUBTOOLS` listed HSL
  // unconditionally and the shell's safety-net effect visibly bounced the
  // panel body back to B&W the instant the chip was tapped).
  it('drops the HSL chip from the colour row while Black & White is On', () => {
    const bwOff = render({ activeGroup: 'color', blackWhiteOn: false });
    const bwOffChips = Array.from(
      (bwOff.nativeElement as HTMLElement).querySelectorAll('.subtool-chip'),
    ).map((n) => n.textContent!.trim());
    expect(bwOffChips).toEqual(['Basic', 'HSL', 'B&W']);

    const bwOn = render({ activeGroup: 'color', blackWhiteOn: true });
    const bwOnChips = Array.from(
      (bwOn.nativeElement as HTMLElement).querySelectorAll('.subtool-chip'),
    ).map((n) => n.textContent!.trim());
    expect(bwOnChips).toEqual(['Basic', 'B&W']);

    // Effects' row is untouched — the filter only applies to Colour's HSL
    // chip, not to the whole component.
    const effects = render({ activeGroup: 'effects', blackWhiteOn: true });
    const effectsChips = Array.from(
      (effects.nativeElement as HTMLElement).querySelectorAll('.subtool-chip'),
    ).map((n) => n.textContent!.trim());
    expect(effectsChips).toEqual(['Basic', 'Grade']);
  });

  it('emits the same tool a dock button used to arm, in each group', () => {
    const colour = render({ activeGroup: 'color' });
    const colourEmitted: string[] = [];
    colour.componentInstance.toolChange.subscribe((t: string) => colourEmitted.push(t));
    const colourChips = (colour.nativeElement as HTMLElement).querySelectorAll('.subtool-chip');
    (colourChips[1] as HTMLButtonElement).click(); // HSL
    (colourChips[2] as HTMLButtonElement).click(); // B&W
    expect(colourEmitted).toEqual(['hsl', 'bwMix']);

    const effects = render({ activeGroup: 'effects' });
    const effectsEmitted: string[] = [];
    effects.componentInstance.toolChange.subscribe((t: string) => effectsEmitted.push(t));
    const effectsChips = (effects.nativeElement as HTMLElement).querySelectorAll('.subtool-chip');
    (effectsChips[1] as HTMLButtonElement).click(); // Grade
    expect(effectsEmitted).toEqual(['colorGrade']);
  });

  it('marks the chip matching the armed tool active, defaulting to Basic', () => {
    const hsl = render({ activeGroup: 'color', activeTool: 'hsl' });
    expect(
      (hsl.nativeElement as HTMLElement)
        .querySelector('.subtool-chip--active')
        ?.textContent?.trim(),
    ).toBe('HSL');

    const basic = render({ activeGroup: 'color', activeTool: 'temp' });
    expect(
      (basic.nativeElement as HTMLElement)
        .querySelector('.subtool-chip--active')
        ?.textContent?.trim(),
    ).toBe('Basic');

    const grade = render({ activeGroup: 'effects', activeTool: 'colorGrade' });
    expect(
      (grade.nativeElement as HTMLElement)
        .querySelector('.subtool-chip--active')
        ?.textContent?.trim(),
    ).toBe('Grade');
  });

  // `EditorStateService.armGroup` deliberately retains the currently-armed
  // tool when the target group is already the armed group (own spec:
  // "retains tool when arming the same group") — right for the dock's group
  // buttons, but this row only ever shows once the group already matches
  // (`showSubtools`), so a naive `groupChange.emit(activeGroup())` on Basic
  // would always hit that retain branch and never actually leave HSL/bwMix/
  // Grade. Basic must arm the group's first slider tool directly to be a
  // real escape hatch — verified in both rows since each group's first
  // slider tool differs (`temp` vs `clarity`).
  it('Basic arms the group’s first slider tool directly when escaping a field-less sub-tool', () => {
    const hsl = render({ activeGroup: 'color', activeTool: 'hsl' });
    const hslToolsEmitted: string[] = [];
    const hslGroupsEmitted: string[] = [];
    hsl.componentInstance.toolChange.subscribe((t: string) => hslToolsEmitted.push(t));
    hsl.componentInstance.groupChange.subscribe((g: string) => hslGroupsEmitted.push(g));
    (
      (hsl.nativeElement as HTMLElement).querySelectorAll('.subtool-chip')[0] as HTMLButtonElement
    ).click();
    expect(hslToolsEmitted).toEqual(['temp']);
    expect(hslGroupsEmitted).toEqual([]);

    const grade = render({ activeGroup: 'effects', activeTool: 'colorGrade' });
    const gradeToolsEmitted: string[] = [];
    const gradeGroupsEmitted: string[] = [];
    grade.componentInstance.toolChange.subscribe((t: string) => gradeToolsEmitted.push(t));
    grade.componentInstance.groupChange.subscribe((g: string) => gradeGroupsEmitted.push(g));
    (
      (grade.nativeElement as HTMLElement).querySelectorAll('.subtool-chip')[0] as HTMLButtonElement
    ).click();
    expect(gradeToolsEmitted).toEqual(['clarity']);
    expect(gradeGroupsEmitted).toEqual([]);
  });

  it('Basic re-affirms the active group (not a tool) when a plain slider is already armed', () => {
    const colour = render({ activeGroup: 'color', activeTool: 'temp' });
    const colourToolsEmitted: string[] = [];
    const colourGroupsEmitted: string[] = [];
    colour.componentInstance.toolChange.subscribe((t: string) => colourToolsEmitted.push(t));
    colour.componentInstance.groupChange.subscribe((g: string) => colourGroupsEmitted.push(g));
    (
      (colour.nativeElement as HTMLElement).querySelectorAll(
        '.subtool-chip',
      )[0] as HTMLButtonElement
    ).click();
    expect(colourGroupsEmitted).toEqual(['color']);
    expect(colourToolsEmitted).toEqual([]);

    const effects = render({ activeGroup: 'effects', activeTool: 'clarity' });
    const effectsToolsEmitted: string[] = [];
    const effectsGroupsEmitted: string[] = [];
    effects.componentInstance.toolChange.subscribe((t: string) => effectsToolsEmitted.push(t));
    effects.componentInstance.groupChange.subscribe((g: string) => effectsGroupsEmitted.push(g));
    (
      (effects.nativeElement as HTMLElement).querySelectorAll(
        '.subtool-chip',
      )[0] as HTMLButtonElement
    ).click();
    expect(effectsGroupsEmitted).toEqual(['effects']);
    expect(effectsToolsEmitted).toEqual([]);
  });
});
