// BottomSheetComponent — phone Info modal primitive (S1c, #599).
//
// Verifies the spec-compliant Web bottom-sheet contract:
//   - Open/close visibility driven by the writable `isOpen` model().
//   - Scrim click + Escape key both dismiss the sheet.
//   - <ng-content> projection renders inside the sheet body.
//   - Dialog ARIA semantics on the sheet container.
//
// Drag-to-dismiss (PointerEvents + velocity threshold) is exercised by a
// Playwright e2e at src/web/e2e/bottom-sheet.spec.ts — jsdom does not
// model PointerEvents fidelity well enough to make a unit assertion
// trustworthy. Keep this spec focused on DOM contract only.

import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { describe, it, expect, beforeEach } from 'vitest';

import { BottomSheetComponent } from './bottom-sheet.component';

@Component({
  standalone: true,
  imports: [BottomSheetComponent],
  template: `
    <app-bottom-sheet [(isOpen)]="open">
      <p data-testid="projected">Hello from projection</p>
    </app-bottom-sheet>
  `,
})
class HostComponent {
  open = false;
}

describe('BottomSheetComponent', () => {
  beforeEach(() => {
    TestBed.resetTestingModule();
  });

  it('renders nothing when isOpen is false', () => {
    const fixture = TestBed.createComponent(HostComponent);
    fixture.detectChanges();

    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('.scrim')).toBeNull();
    expect(el.querySelector('.sheet')).toBeNull();
  });

  it('renders the scrim and sheet when isOpen is true', () => {
    const fixture = TestBed.createComponent(HostComponent);
    fixture.componentInstance.open = true;
    fixture.detectChanges();

    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('.scrim')).not.toBeNull();
    const sheet = el.querySelector('.sheet');
    expect(sheet).not.toBeNull();
    expect(sheet!.getAttribute('role')).toBe('dialog');
    expect(sheet!.getAttribute('aria-modal')).toBe('true');
  });

  it('renders the grab handle inside the sheet', () => {
    const fixture = TestBed.createComponent(HostComponent);
    fixture.componentInstance.open = true;
    fixture.detectChanges();

    const handle = (fixture.nativeElement as HTMLElement).querySelector('.grab-handle');
    expect(handle).not.toBeNull();
    expect(handle!.getAttribute('aria-hidden')).toBe('true');
  });

  it('projects host content via <ng-content>', () => {
    const fixture = TestBed.createComponent(HostComponent);
    fixture.componentInstance.open = true;
    fixture.detectChanges();

    const projected = (fixture.nativeElement as HTMLElement).querySelector(
      '[data-testid="projected"]',
    );
    expect(projected).not.toBeNull();
    expect(projected!.textContent).toContain('Hello from projection');
    // Projection target must be inside the sheet, not floating in the scrim.
    const sheet = (fixture.nativeElement as HTMLElement).querySelector('.sheet');
    expect(sheet!.contains(projected)).toBe(true);
  });

  it('clicking the scrim dismisses the sheet (two-way isOpen propagates)', () => {
    const fixture = TestBed.createComponent(HostComponent);
    fixture.componentInstance.open = true;
    fixture.detectChanges();

    const scrim = (fixture.nativeElement as HTMLElement).querySelector('.scrim') as HTMLElement;
    scrim.click();
    fixture.detectChanges();

    expect(fixture.componentInstance.open).toBe(false);
    expect((fixture.nativeElement as HTMLElement).querySelector('.sheet')).toBeNull();
  });

  it('clicking the sheet body does NOT dismiss (scrim-only)', () => {
    const fixture = TestBed.createComponent(HostComponent);
    fixture.componentInstance.open = true;
    fixture.detectChanges();

    const sheet = (fixture.nativeElement as HTMLElement).querySelector('.sheet') as HTMLElement;
    sheet.click();
    fixture.detectChanges();

    expect(fixture.componentInstance.open).toBe(true);
  });

  it('Escape key on the sheet dismisses it', () => {
    const fixture = TestBed.createComponent(HostComponent);
    fixture.componentInstance.open = true;
    fixture.detectChanges();

    const sheet = (fixture.nativeElement as HTMLElement).querySelector('.sheet') as HTMLElement;
    sheet.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    fixture.detectChanges();

    expect(fixture.componentInstance.open).toBe(false);
  });
});
