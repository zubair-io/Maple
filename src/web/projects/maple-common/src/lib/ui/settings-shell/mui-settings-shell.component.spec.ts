import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import type { ComponentFixture } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';

import { MuiSettingsShellComponent } from './mui-settings-shell.component';

@Component({
  standalone: true,
  imports: [MuiSettingsShellComponent],
  template: `
    <mui-settings-shell [navWidth]="navWidth" [paneMaxWidth]="paneMaxWidth">
      <div slot="nav" class="nav-probe">Nav</div>
      <div class="pane-probe">Pane</div>
    </mui-settings-shell>
  `,
})
class HostComponent {
  navWidth = 240;
  paneMaxWidth = 640;
}

function render(): ComponentFixture<HostComponent> {
  TestBed.configureTestingModule({ imports: [HostComponent] });
  const fixture = TestBed.createComponent(HostComponent);
  fixture.detectChanges();
  return fixture;
}

describe('MuiSettingsShellComponent', () => {
  it('projects nav and pane into their own regions', () => {
    const fixture = render();
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('.nav .nav-probe')).not.toBeNull();
    expect(el.querySelector('.pane .pane-probe')).not.toBeNull();
  });

  it('sets the nav width and pane max-width from inputs', () => {
    const fixture = render();
    const el = fixture.nativeElement as HTMLElement;
    const nav = el.querySelector('.nav') as HTMLElement;
    const pane = el.querySelector('.pane') as HTMLElement;
    expect(nav.style.getPropertyValue('--mui-settings-nav-width')).toBe('240px');
    expect(pane.style.maxWidth).toBe('640px');
  });
});
