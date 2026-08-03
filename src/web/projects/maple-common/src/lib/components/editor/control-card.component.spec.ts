// control-card.component.spec.ts — flyout header parity (accent group title,
// no chip row, no grab handle) vs the phone flyout (#1807): close button and
// the `closed` input hiding the whole card so only the bottom dock remains
// visible.

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

function render(inputs: { phone?: boolean; closed?: boolean; activeGroup?: string } = {}): {
  fixture: ComponentFixture<ControlCardComponent>;
  updateAdjustment: ReturnType<typeof vi.fn>;
  commit: ReturnType<typeof vi.fn>;
  haptic: ReturnType<typeof vi.fn>;
} {
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
  if (inputs.phone !== undefined) fixture.componentRef.setInput('phone', inputs.phone);
  if (inputs.closed !== undefined) fixture.componentRef.setInput('closed', inputs.closed);
  fixture.detectChanges();
  return { fixture, updateAdjustment, commit, haptic };
}

describe('ControlCardComponent — tablet/desktop (default)', () => {
  it('does not render a close button', () => {
    const { fixture } = render();
    expect(fixture.nativeElement.querySelector('.close-btn')).toBeFalsy();
  });

  it('ignores the closed input entirely — card always renders', () => {
    const { fixture } = render({ closed: true });
    expect(fixture.nativeElement.querySelector('.card')).toBeTruthy();
  });
});

describe('ControlCardComponent — phone flyout (#1807)', () => {
  it('suppresses the group-chips row and shows the active group title instead', () => {
    const { fixture } = render({ phone: true, activeGroup: 'color', closed: false });
    expect(fixture.nativeElement.querySelector('.group-chips')).toBeFalsy();
    const title = fixture.nativeElement.querySelector('.group-title');
    expect(title?.textContent?.trim()).toBe('COLOR');
  });

  it('shows a close button that emits closeRequest', () => {
    const { fixture } = render({ phone: true, closed: false });
    let closed = 0;
    fixture.componentInstance.closeRequest.subscribe(() => closed++);
    const closeBtn = (fixture.nativeElement as HTMLElement).querySelector<HTMLButtonElement>(
      '.close-btn',
    );
    expect(closeBtn).toBeTruthy();
    closeBtn!.click();
    expect(closed).toBe(1);
  });

  it('renders nothing when closed=true', () => {
    const { fixture } = render({ phone: true, closed: true });
    expect(fixture.nativeElement.querySelector('.card')).toBeFalsy();
  });

  it('renders the card (with sliders) when closed=false', () => {
    const { fixture } = render({ phone: true, closed: false, activeGroup: 'light' });
    expect(fixture.nativeElement.querySelector('.card')).toBeTruthy();
    expect(fixture.nativeElement.querySelector('.slider-grid')).toBeTruthy();
    expect(fixture.nativeElement.querySelectorAll('pro-living-slider').length).toBeGreaterThan(0);
  });

  it('still exposes the reset button when open', () => {
    const { fixture } = render({ phone: true, closed: false });
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
