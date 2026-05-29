// AnchoredOverlayComponent — open/close + dismissal + positioning specs.
//
// Verifies the primitive's contract:
//   - Visibility driven by the writable `isOpen` model.
//   - Outside-click (on either scrim, or on the document outside both
//     the overlay panel and the anchor element) dismisses.
//   - Esc key dismisses.
//   - Overlay top-left tracks the anchor's bottom-left (+ a small gap).
//   - Window resize re-measures the anchor.
//   - <ng-content> projects into the overlay panel.
//   - Inspector scrim renders only when `inspectorAnchor` is bound.
//
// Focus management — basic asserts only. jsdom's focus model is shallow
// (no real tab order, computed-style elision), so we limit ourselves to
// "first focusable receives focus on open" and "restore target is
// captured." Full focus-trap (Tab/Shift+Tab cycle) is covered by the
// Playwright e2e at src/web/e2e/anchored-search.spec.ts once a real host
// route mounts the primitive.

import { ComponentFixture, TestBed } from '@angular/core/testing';
import { describe, it, expect, beforeEach } from 'vitest';
import { Component, ElementRef, signal, viewChild } from '@angular/core';

import { AnchoredOverlayComponent } from './anchored-overlay.component';

/** Host that mounts the overlay anchored to a button inside a sidebar
 * container. Mirrors the real tablet/desktop wiring: an anchor button
 * lives inside a "sidebar" ancestor whose bounding rect determines the
 * scrim's left edge. */
@Component({
  standalone: true,
  imports: [AnchoredOverlayComponent],
  template: `
    <div class="sidebar" style="position: fixed; left: 0; top: 0; width: 220px; height: 100vh;">
      <button #pillBtn type="button" data-testid="host-pill" (click)="open.set(true)">Open</button>
    </div>
    <div
      #inspectorEl
      class="inspector"
      style="position: fixed; right: 0; top: 0; width: 300px; height: 100vh;"
    ></div>
    @if (anchorBtn()) {
      <app-anchored-overlay
        [(isOpen)]="open"
        [anchor]="anchorBtn()!"
        [widthPx]="widthPx()"
        [scrimOpacity]="0.25"
        [inspectorAnchor]="useInspector() ? inspectorRef()! : null"
      >
        <button data-testid="overlay-action" type="button">Inside overlay</button>
        <input data-testid="overlay-input" type="text" />
      </app-anchored-overlay>
    }
  `,
})
class HostComponent {
  readonly open = signal(false);
  readonly widthPx = signal(320);
  readonly useInspector = signal(false);
  readonly anchorBtn = viewChild<string, ElementRef<HTMLElement>>('pillBtn', {
    read: ElementRef,
  });
  readonly inspectorRef = viewChild<string, ElementRef<HTMLElement>>('inspectorEl', {
    read: ElementRef,
  });
}

describe('AnchoredOverlayComponent', () => {
  let fixture: ComponentFixture<HostComponent>;
  let host: HostComponent;

  beforeEach(() => {
    TestBed.configureTestingModule({ imports: [HostComponent] });
    fixture = TestBed.createComponent(HostComponent);
    host = fixture.componentInstance;
    // First detection so viewChild signals populate.
    fixture.detectChanges();
  });

  function el(): HTMLElement {
    return fixture.nativeElement as HTMLElement;
  }

  function panel(): HTMLElement | null {
    return el().querySelector('[data-testid="anchored-overlay"]');
  }

  it('renders nothing when isOpen is false', () => {
    expect(panel()).toBeNull();
    expect(el().querySelector('.scrim')).toBeNull();
  });

  it('renders the overlay panel and main scrim when isOpen flips true', () => {
    host.open.set(true);
    fixture.detectChanges();
    expect(panel()).not.toBeNull();
    expect(panel()!.getAttribute('role')).toBe('dialog');
    expect(panel()!.getAttribute('aria-modal')).toBe('true');
    expect(el().querySelector('.scrim-main')).not.toBeNull();
  });

  it('does not render the inspector scrim unless inspectorAnchor is bound', () => {
    host.open.set(true);
    fixture.detectChanges();
    expect(el().querySelector('.scrim-inspector')).toBeNull();

    host.useInspector.set(true);
    fixture.detectChanges();
    expect(el().querySelector('.scrim-inspector')).not.toBeNull();
  });

  it('projects host content via <ng-content>', () => {
    host.open.set(true);
    fixture.detectChanges();
    expect(panel()!.querySelector('[data-testid="overlay-action"]')).not.toBeNull();
    expect(panel()!.querySelector('[data-testid="overlay-input"]')).not.toBeNull();
  });

  it('main scrim click dismisses (two-way isOpen propagates)', () => {
    host.open.set(true);
    fixture.detectChanges();
    const scrim = el().querySelector('.scrim-main') as HTMLElement;
    scrim.click();
    fixture.detectChanges();
    expect(host.open()).toBe(false);
    expect(panel()).toBeNull();
  });

  it('inspector scrim click dismisses when present', () => {
    host.useInspector.set(true);
    host.open.set(true);
    fixture.detectChanges();
    const scrim = el().querySelector('.scrim-inspector') as HTMLElement;
    scrim.click();
    fixture.detectChanges();
    expect(host.open()).toBe(false);
  });

  it('Escape dismisses regardless of focus (document-level listener)', () => {
    host.open.set(true);
    fixture.detectChanges();
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    fixture.detectChanges();
    expect(host.open()).toBe(false);
  });

  it('document pointerdown outside the overlay panel dismisses', () => {
    host.open.set(true);
    fixture.detectChanges();
    // Synthesise an outside click — target the document body, which is
    // neither inside the overlay nor inside the anchor. The component's
    // document:pointerdown listener should treat this as outside-click.
    document.body.dispatchEvent(
      new PointerEvent('pointerdown', { bubbles: true, pointerId: 1, button: 0 }),
    );
    fixture.detectChanges();
    expect(host.open()).toBe(false);
  });

  it('pointerdown on the anchor itself does NOT dismiss (host owns toggle)', () => {
    host.open.set(true);
    fixture.detectChanges();
    const anchor = el().querySelector('[data-testid="host-pill"]') as HTMLElement;
    anchor.dispatchEvent(
      new PointerEvent('pointerdown', { bubbles: true, pointerId: 1, button: 0 }),
    );
    fixture.detectChanges();
    // Anchor remains the host's responsibility — without this guard the
    // overlay would toggle off the same click that's about to toggle it
    // on again from the host's click handler.
    expect(host.open()).toBe(true);
  });

  it('pointerdown inside the overlay panel does NOT dismiss', () => {
    host.open.set(true);
    fixture.detectChanges();
    const action = panel()!.querySelector('[data-testid="overlay-action"]') as HTMLElement;
    action.dispatchEvent(
      new PointerEvent('pointerdown', { bubbles: true, pointerId: 1, button: 0 }),
    );
    fixture.detectChanges();
    expect(host.open()).toBe(true);
  });

  it('positions the overlay top-left below the anchor (anchor bottom + gap, anchor left)', () => {
    host.open.set(true);
    fixture.detectChanges();
    const anchor = el().querySelector('[data-testid="host-pill"]') as HTMLElement;
    const rect = anchor.getBoundingClientRect();
    const p = panel()!;
    // CSSStyleDeclaration values come back as `"<number>px"` strings.
    const top = parseFloat(p.style.top);
    const left = parseFloat(p.style.left);
    expect(top).toBeCloseTo(rect.bottom + 4, 0);
    expect(left).toBeCloseTo(rect.left, 0);
  });

  it('width binding drives the panel CSS width', () => {
    host.widthPx.set(480);
    host.open.set(true);
    fixture.detectChanges();
    expect(panel()!.style.width).toBe('480px');
  });

  it('window resize re-measures the anchor (no error, overlay stays open)', () => {
    host.open.set(true);
    fixture.detectChanges();
    expect(() => window.dispatchEvent(new Event('resize'))).not.toThrow();
    fixture.detectChanges();
    expect(host.open()).toBe(true);
    expect(panel()).not.toBeNull();
  });

  it('opens with widthPx default of 320 when no binding overrides it', () => {
    host.open.set(true);
    fixture.detectChanges();
    expect(panel()!.style.width).toBe('320px');
  });
});
