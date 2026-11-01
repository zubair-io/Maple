import { TestBed } from '@angular/core/testing';
import type { ComponentFixture } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';

import { MuiToggleComponent } from './mui-toggle.component';

function render(inputs: Record<string, unknown> = {}): ComponentFixture<MuiToggleComponent> {
  TestBed.configureTestingModule({ imports: [MuiToggleComponent] });
  const fixture = TestBed.createComponent(MuiToggleComponent);
  for (const [name, value] of Object.entries(inputs)) fixture.componentRef.setInput(name, value);
  fixture.detectChanges();
  return fixture;
}

function control(fixture: ComponentFixture<MuiToggleComponent>): HTMLButtonElement {
  return fixture.nativeElement.querySelector('button') as HTMLButtonElement;
}

describe('MuiToggleComponent', () => {
  it('is a native switch, off by default, reflecting checked in aria-checked', () => {
    const fixture = render({ label: 'Auto Crop' });
    expect(control(fixture).getAttribute('role')).toBe('switch');
    expect(control(fixture).getAttribute('aria-checked')).toBe('false');
    fixture.componentRef.setInput('checked', true);
    fixture.detectChanges();
    expect(control(fixture).getAttribute('aria-checked')).toBe('true');
  });

  it('names the switch from its visible label', () => {
    const fixture = render({ label: 'Auto Crop', ariaLabel: 'ignored' });
    expect(fixture.nativeElement.querySelector('.label').textContent.trim()).toBe('Auto Crop');
    expect(control(fixture).hasAttribute('aria-label')).toBe(false);
  });

  it('names an unlabeled switch from ariaLabel', () => {
    const fixture = render({ ariaLabel: 'Auto Crop' });
    expect(control(fixture).getAttribute('aria-label')).toBe('Auto Crop');
  });

  it('emits the opposite state on click and leaves its own state to the caller', () => {
    const fixture = render({ label: 'Auto Crop' });
    const emitted: boolean[] = [];
    fixture.componentInstance.checkedChange.subscribe((v) => emitted.push(v));
    control(fixture).click();
    expect(emitted).toEqual([true]);
    expect(control(fixture).getAttribute('aria-checked')).toBe('false');
    fixture.componentRef.setInput('checked', true);
    fixture.detectChanges();
    control(fixture).click();
    expect(emitted).toEqual([true, false]);
  });

  it('does not emit while disabled', () => {
    const fixture = render({ label: 'Auto Crop', disabled: true });
    const emitted: boolean[] = [];
    fixture.componentInstance.checkedChange.subscribe((v) => emitted.push(v));
    control(fixture).click();
    expect(control(fixture).disabled).toBe(true);
    expect(emitted).toEqual([]);
  });

  it('links a describing element through aria-describedby', () => {
    const fixture = render({ label: 'Auto Crop', ariaDescribedBy: 'helper-1' });
    expect(control(fixture).getAttribute('aria-describedby')).toBe('helper-1');
  });

  it('moves the thumb and recolors the track when on', () => {
    const fixture = render({ label: 'Auto Crop' });
    const track = fixture.nativeElement.querySelector('.track') as HTMLElement;
    const thumb = fixture.nativeElement.querySelector('.thumb') as HTMLElement;
    expect(track.className).toContain('bg-border');
    expect(thumb.className).toContain('translate-x-0');
    fixture.componentRef.setInput('checked', true);
    fixture.detectChanges();
    expect(track.className).toContain('bg-primary');
    expect(thumb.className).toContain('translate-x-[14px]');
  });
});
