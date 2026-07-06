// tool-dock.component.spec.ts — vertical (tablet/desktop) vs horizontal
// (phone, #1807) orientation, entry filtering, group/curve wiring, and the
// disabled Crop entry's tooltip.

import { describe, it, expect } from 'vitest';
import { TestBed } from '@angular/core/testing';

import { ToolDockComponent } from './tool-dock.component';

function render(inputs: {
  activeGroup?: string;
  curveOpen?: boolean;
  orientation?: 'vertical' | 'horizontal';
}) {
  TestBed.configureTestingModule({ imports: [ToolDockComponent] });
  const fixture = TestBed.createComponent(ToolDockComponent);
  fixture.componentRef.setInput('activeGroup', inputs.activeGroup ?? 'light');
  if (inputs.curveOpen !== undefined) {
    fixture.componentRef.setInput('curveOpen', inputs.curveOpen);
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

describe('ToolDockComponent — vertical (default) orientation', () => {
  it('defaults to vertical orientation', () => {
    const fixture = render({});
    expect(fixture.componentInstance.orientation()).toBe('vertical');
  });

  it('renders the 8 tablet/desktop entries and excludes Crop', () => {
    const fixture = render({});
    const labels = buttons(fixture).map((b) => b.getAttribute('aria-label'));
    expect(labels).toEqual([
      'Light',
      'Color',
      'Curve',
      'Effects',
      'Detail',
      'Optics',
      'Mask',
      'Heal',
    ]);
    expect(labels).not.toContain('Crop');
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

  it('renders exactly Light/Color/Effects/Detail/Curve/Crop, excluding Optics/Mask/Heal', () => {
    const fixture = render({ orientation: 'horizontal' });
    const labels = buttons(fixture).map((b) => b.getAttribute('aria-label'));
    expect(labels).toEqual(['Light', 'Color', 'Curve', 'Effects', 'Detail', 'Crop']);
  });

  it('Crop is disabled with a #1807 tooltip (no fake crop panel per CLAUDE.md #6)', () => {
    const fixture = render({ orientation: 'horizontal' });
    const cropBtn = buttonFor(fixture, 'Crop');
    expect(cropBtn.disabled).toBe(true);
    expect(cropBtn.title).toBe('Crop — coming in #1807');
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
