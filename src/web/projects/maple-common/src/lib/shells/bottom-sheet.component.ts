// BottomSheetComponent — Web bottom-sheet primitive (S1c, #599).
//
// Spec: docs/spec/responsive-program-s1-phone-shell.md §4.2.
//
// Phone-tier Info modal (consumed by S4 Loupe, S5 Editor, S6 phone Detail
// reuse). Hand-rolled so the Web matches the design spec exactly:
//   - 35% scrim, 74vh sheet, 18px top corners.
//   - 38×4px grab handle in muted grey, inside a top `.drag-area` band.
//   - Pan-down to dismiss is initiated only from the top `.drag-area`,
//     keeping projected content scrollable without gesture conflicts.
//     Distance ≥ 25% of sheet height OR velocity ≥ 1000 px/s at release.
//   - Scrim tap + document-level Escape also dismiss.
//
// Apple ships a thinner `mapleBottomSheet` View extension wrapping
// `.sheet(.presentationDetents([.fraction(0.74)]))` — see
// src/apple/Maple/Views/BottomSheet.swift. The Web takes the hand-rolled
// path because spec compliance (precise scrim alpha, custom handle,
// custom dismiss threshold) is not reachable through public SwiftUI
// presentation modifiers as of iOS 18.

import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  ViewChild,
  model,
  signal,
} from '@angular/core';
import {
  beginSheetDrag,
  isDistanceDismissed,
  shouldIgnoreSheetPointerDown,
  updateSheetDragOffset,
} from '../ui/internal/sheet-drag';

/** Pan-down threshold as a fraction of sheet height. Spec §4.2. */
const DISMISS_FRACTION = 0.25;
/** Pointer velocity threshold for flick-down dismiss (px/s). Spec §4.2. */
const DISMISS_VELOCITY = 1000;
/** Window over which we measure release velocity (ms). */
const VELOCITY_WINDOW_MS = 100;

@Component({
  selector: 'app-bottom-sheet',
  standalone: true,
  templateUrl: './bottom-sheet.component.html',
  styleUrl: './bottom-sheet.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    // Document-level Escape so the sheet dismisses regardless of where focus
    // sits (typically still on the opener button behind the scrim, since the
    // sheet is `tabindex="-1"` and not auto-focused on open).
    '(document:keydown.escape)': 'onEscape($event)',
  },
})
export class BottomSheetComponent {
  /** Two-way: parent owns whether the sheet is presented. */
  readonly isOpen = model<boolean>(false);

  /** Live drag offset in CSS pixels; bound to the sheet's transform. */
  protected readonly dragOffsetPx = signal(0);
  /** Suppresses the SCSS transition while a drag is in flight. */
  protected readonly isDragging = signal(false);

  @ViewChild('sheetEl') private sheetEl?: ElementRef<HTMLElement>;

  private pointerId: number | null = null;
  private dragStartY = 0;
  private dragStartTimestamp = 0;
  private lastSampleY = 0;
  private lastSampleTimestamp = 0;

  protected onScrimClick(): void {
    this.isOpen.set(false);
  }

  /** Document-level Escape dismisses (keyboard parity with the scrim). */
  protected onEscape(event: Event): void {
    if (!this.isOpen()) return;
    event.preventDefault();
    this.isOpen.set(false);
  }

  protected onPointerDown(event: PointerEvent): void {
    // Only react to primary pointer; ignore mouse right-click etc.
    if (shouldIgnoreSheetPointerDown(event)) return;
    this.pointerId = event.pointerId;
    this.dragStartY = event.clientY;
    this.dragStartTimestamp = event.timeStamp;
    this.lastSampleY = event.clientY;
    this.lastSampleTimestamp = event.timeStamp;
    beginSheetDrag(event, this.isDragging, this.dragOffsetPx);
  }

  protected onPointerMove(event: PointerEvent): void {
    if (!updateSheetDragOffset(event, this.pointerId, this.dragStartY, this.dragOffsetPx)) return;
    this.lastSampleY = event.clientY;
    this.lastSampleTimestamp = event.timeStamp;
  }

  protected onPointerUp(event: PointerEvent): void {
    if (this.pointerId !== event.pointerId) return;
    const dy = Math.max(0, event.clientY - this.dragStartY);
    const sheetHeight = this.sheetEl?.nativeElement.getBoundingClientRect().height ?? 0;
    const distanceTriggered = isDistanceDismissed(dy, sheetHeight, DISMISS_FRACTION);

    // Velocity over the last ~100ms — robust to a slow lead-in followed
    // by a flick. Fall back to overall drag if the sample is too short.
    const dt = Math.max(1, event.timeStamp - this.lastSampleTimestamp);
    const recentVelocity = ((event.clientY - this.lastSampleY) / dt) * 1000;
    const totalDt = Math.max(1, event.timeStamp - this.dragStartTimestamp);
    const overallVelocity = (dy / totalDt) * 1000;
    const sampledVelocity = totalDt < VELOCITY_WINDOW_MS ? overallVelocity : recentVelocity;
    const velocityTriggered = sampledVelocity >= DISMISS_VELOCITY;

    this.pointerId = null;
    this.isDragging.set(false);
    this.dragOffsetPx.set(0);

    if (distanceTriggered || velocityTriggered) {
      this.isOpen.set(false);
    }
  }

  protected onPointerCancel(event: PointerEvent): void {
    if (this.pointerId !== event.pointerId) return;
    this.pointerId = null;
    this.isDragging.set(false);
    this.dragOffsetPx.set(0);
  }
}
