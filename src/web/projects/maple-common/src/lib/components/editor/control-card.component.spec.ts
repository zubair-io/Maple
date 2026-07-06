// control-card.component.spec.ts — group chips (tablet/desktop) vs the phone
// flyout (#1807): suppressed chip row, close button, and the `closed` input
// hiding the whole card so only the bottom dock remains visible.

import { describe, it, expect, vi } from 'vitest';
import { TestBed } from '@angular/core/testing';
import type { ComponentFixture } from '@angular/core/testing';
import { signal } from '@angular/core';

import { ControlCardComponent } from './control-card.component';
import { EditorStateService } from '../../editor/editor-state.service';
import { LibraryStateService } from '../../state/library-state.service';
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

  TestBed.configureTestingModule({
    imports: [ControlCardComponent],
    providers: [
      { provide: EditorStateService, useValue: { commit, haptic } },
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
  it('renders the group-chips row', () => {
    const { fixture } = render();
    expect(fixture.nativeElement.querySelector('.group-chips')).toBeTruthy();
  });

  it('does not render a close button', () => {
    const { fixture } = render();
    expect(fixture.nativeElement.querySelector('.close-btn')).toBeFalsy();
  });

  it('ignores the closed input entirely — card always renders', () => {
    const { fixture } = render({ closed: true });
    expect(fixture.nativeElement.querySelector('.card')).toBeTruthy();
  });

  it('clicking a chip emits groupChange', () => {
    const { fixture } = render({ activeGroup: 'light' });
    let emitted: string | undefined;
    fixture.componentInstance.groupChange.subscribe((g) => (emitted = g));
    const chips = Array.from(
      (fixture.nativeElement as HTMLElement).querySelectorAll<HTMLButtonElement>('.group-chip'),
    );
    const colorChip = chips.find((c) => c.textContent?.trim() === 'Color')!;
    colorChip.click();
    expect(emitted).toBe('color');
  });
});

describe('ControlCardComponent — phone flyout (#1807)', () => {
  it('suppresses the group-chips row and shows the active group label instead', () => {
    const { fixture } = render({ phone: true, activeGroup: 'color', closed: false });
    expect(fixture.nativeElement.querySelector('.group-chips')).toBeFalsy();
    const label = fixture.nativeElement.querySelector('.phone-group-label');
    expect(label?.textContent?.trim()).toBe('Color');
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
