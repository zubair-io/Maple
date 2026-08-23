import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import type { ComponentFixture } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';

import { MuiSplitLayoutComponent } from './mui-split-layout.component';

@Component({
  standalone: true,
  imports: [MuiSplitLayoutComponent],
  template: `
    <mui-split-layout
      [(sidebarWidth)]="sidebarWidth"
      [(detailWidth)]="detailWidth"
      [showDetail]="showDetail()"
    >
      <div slot="sidebar" class="sidebar-probe">Sidebar</div>
      <div class="center-probe">Center</div>
      <div slot="detail" class="detail-probe">Detail</div>
    </mui-split-layout>
  `,
})
class HostComponent {
  sidebarWidth = 260;
  detailWidth = 320;
  readonly showDetail = signal(true);
}

function render(): { fixture: ComponentFixture<HostComponent>; host: HostComponent } {
  TestBed.configureTestingModule({ imports: [HostComponent] });
  const fixture = TestBed.createComponent(HostComponent);
  fixture.detectChanges();
  return { fixture, host: fixture.componentInstance };
}

function pointerEvent(type: string, clientX: number, pointerId = 1): PointerEvent {
  return new PointerEvent(type, { button: 0, clientX, pointerId, bubbles: true });
}

describe('MuiSplitLayoutComponent', () => {
  it('projects sidebar, center, and detail into their own regions', () => {
    const { fixture } = render();
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('.sidebar .sidebar-probe')).not.toBeNull();
    expect(el.querySelector('.center .center-probe')).not.toBeNull();
    expect(el.querySelector('.detail .detail-probe')).not.toBeNull();
  });

  it('renders the sidebar and detail widths from the model inputs', () => {
    const { fixture } = render();
    const el = fixture.nativeElement as HTMLElement;
    expect((el.querySelector('.sidebar') as HTMLElement).style.width).toBe('260px');
    expect((el.querySelector('.detail') as HTMLElement).style.width).toBe('320px');
  });

  it('omits the detail region and its handle when showDetail is false', () => {
    const { fixture, host } = render();
    host.showDetail.set(false);
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('.detail')).toBeNull();
    expect(el.querySelectorAll('.handle').length).toBe(1);
  });

  it('dragging the sidebar handle updates sidebarWidth, clamped to min/max', () => {
    const { fixture, host } = render();
    const handle = fixture.nativeElement.querySelectorAll('.handle')[0] as HTMLElement;
    handle.setPointerCapture = () => {};

    handle.dispatchEvent(pointerEvent('pointerdown', 300));
    handle.dispatchEvent(pointerEvent('pointermove', 340)); // +40px
    fixture.detectChanges();
    expect(host.sidebarWidth).toBe(300);

    // Drag far past the max (400 default) — clamps rather than overshooting.
    handle.dispatchEvent(pointerEvent('pointermove', 1000));
    fixture.detectChanges();
    expect(host.sidebarWidth).toBe(400);
  });

  it('dragging the detail handle left grows detailWidth, clamped to min/max', () => {
    const { fixture, host } = render();
    const handles = fixture.nativeElement.querySelectorAll('.handle');
    const detailHandle = handles[handles.length - 1] as HTMLElement;
    detailHandle.setPointerCapture = () => {};

    detailHandle.dispatchEvent(pointerEvent('pointerdown', 500));
    detailHandle.dispatchEvent(pointerEvent('pointermove', 460)); // -40px -> wider
    fixture.detectChanges();
    expect(host.detailWidth).toBe(360);

    // Drag far past the max (480 default) — clamps rather than overshooting.
    detailHandle.dispatchEvent(pointerEvent('pointermove', -1000));
    fixture.detectChanges();
    expect(host.detailWidth).toBe(480);
  });

  it('ignores pointermove from a pointer that never sent pointerdown', () => {
    const { fixture, host } = render();
    const handle = fixture.nativeElement.querySelectorAll('.handle')[0] as HTMLElement;
    handle.dispatchEvent(pointerEvent('pointermove', 9999, 7));
    fixture.detectChanges();
    expect(host.sidebarWidth).toBe(260);
  });
});
