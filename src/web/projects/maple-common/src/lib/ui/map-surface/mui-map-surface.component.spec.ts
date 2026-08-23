import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import type { ComponentFixture } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';

import { MuiMapSurfaceComponent } from './mui-map-surface.component';
import type { MuiMapAnnotationInput, MuiMapPanOffset } from './mui-map-surface.component';

const CLOSE_PAIR: MuiMapAnnotationInput[] = [
  { id: 'a1', x: 0.5, y: 0.5, label: 'Photo A' },
  { id: 'a2', x: 0.505, y: 0.5, label: 'Photo B' },
];

const FAR_APART: MuiMapAnnotationInput[] = [
  { id: 'a1', x: 0.1, y: 0.1, label: 'Photo A' },
  { id: 'a2', x: 0.9, y: 0.9, label: 'Photo B' },
];

@Component({
  standalone: true,
  imports: [MuiMapSurfaceComponent],
  template: `
    <mui-map-surface
      [annotations]="annotations()"
      [(heatmapVisible)]="heatmapVisible"
      [viewportWidth]="400"
      [viewportHeight]="300"
      (panChanged)="lastPan = $event"
      (annotationSelected)="selectedId = $event"
      (heatmapToggled)="lastToggle = $event"
    />
  `,
})
class HostComponent {
  readonly annotations = signal<readonly MuiMapAnnotationInput[]>(FAR_APART);
  readonly heatmapVisible = signal(false);
  lastPan: MuiMapPanOffset | null = null;
  selectedId: string | null = null;
  lastToggle: boolean | null = null;
}

function render(): { fixture: ComponentFixture<HostComponent>; host: HostComponent } {
  TestBed.configureTestingModule({ imports: [HostComponent] });
  const fixture = TestBed.createComponent(HostComponent);
  fixture.detectChanges();
  const backdrop = fixture.nativeElement.querySelector('.backdrop') as HTMLElement;
  backdrop.setPointerCapture = () => {};
  return { fixture, host: fixture.componentInstance };
}

function pointerEvent(type: string, clientX: number, clientY: number, pointerId = 1): PointerEvent {
  return new PointerEvent(type, { clientX, clientY, pointerId, bubbles: true });
}

describe('MuiMapSurfaceComponent', () => {
  it('renders one pin per far-apart annotation with no cluster count', () => {
    const { fixture } = render();
    const pins = (fixture.nativeElement as HTMLElement).querySelectorAll('.pin');
    expect(pins.length).toBe(2);
  });

  it('groups annotations within the cluster threshold into a single pin with a count', () => {
    const { fixture, host } = render();
    host.annotations.set(CLOSE_PAIR);
    fixture.detectChanges();
    const pins = (fixture.nativeElement as HTMLElement).querySelectorAll('.pin');
    // 0.5 vs 0.505 at 400px width -> 2px apart, well under the default 40px threshold.
    expect(pins.length).toBe(1);
    expect(pins[0].getAttribute('aria-label')).toBe('2 photos');
  });

  it('shows the empty state when there are no annotations', () => {
    const { fixture, host } = render();
    host.annotations.set([]);
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('mui-empty-state')).not.toBeNull();
    expect(el.querySelectorAll('.pin').length).toBe(0);
  });

  it('emits panChanged and moves annotation screen positions when dragging the backdrop', () => {
    const { fixture, host } = render();
    const backdrop = (fixture.nativeElement as HTMLElement).querySelector(
      '.backdrop',
    ) as HTMLElement;
    const pinBefore = (fixture.nativeElement as HTMLElement).querySelector('.pin') as HTMLElement;
    const leftBefore = pinBefore.style.left;

    backdrop.dispatchEvent(pointerEvent('pointerdown', 100, 100));
    backdrop.dispatchEvent(pointerEvent('pointermove', 150, 130));
    fixture.detectChanges();

    expect(host.lastPan).toEqual({ x: 50, y: 30 });
    const pinAfter = (fixture.nativeElement as HTMLElement).querySelector('.pin') as HTMLElement;
    expect(pinAfter.style.left).not.toBe(leftBefore);

    backdrop.dispatchEvent(pointerEvent('pointerup', 150, 130));
  });

  it('emits annotationSelected with the pin id when a single pin is clicked', () => {
    const { fixture, host } = render();
    const pin = (fixture.nativeElement as HTMLElement).querySelector('.pin') as HTMLElement;
    pin.click();
    expect(host.selectedId).toBe('a1');
  });

  it('toggles the heatmap and emits heatmapToggled', () => {
    const { fixture, host } = render();
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('mui-heatmap-layer')).toBeNull();

    const toggleBtn = el.querySelector('.heatmap-toggle button') as HTMLElement;
    toggleBtn.click();
    fixture.detectChanges();

    expect(host.lastToggle).toBe(true);
    expect(host.heatmapVisible()).toBe(true);
    expect(el.querySelector('mui-heatmap-layer')).not.toBeNull();
  });
});
