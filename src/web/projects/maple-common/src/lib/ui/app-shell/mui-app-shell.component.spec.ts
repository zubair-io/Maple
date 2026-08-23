import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import type { ComponentFixture } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';

import { MuiAppShellComponent } from './mui-app-shell.component';

@Component({
  standalone: true,
  imports: [MuiAppShellComponent],
  template: `
    <mui-app-shell [navPlacement]="placement()">
      <div slot="nav" class="nav-probe">Nav</div>
      <div slot="overlay" class="overlay-probe">Overlay</div>
      <div class="content-probe">Content</div>
    </mui-app-shell>
  `,
})
class HostComponent {
  readonly placement = signal<'top' | 'side'>('top');
}

function render(): ComponentFixture<HostComponent> {
  TestBed.configureTestingModule({ imports: [HostComponent] });
  const fixture = TestBed.createComponent(HostComponent);
  fixture.detectChanges();
  return fixture;
}

describe('MuiAppShellComponent', () => {
  it('projects nav, content, and overlay into their own regions', () => {
    const fixture = render();
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('.nav .nav-probe')).not.toBeNull();
    expect(el.querySelector('.content .content-probe')).not.toBeNull();
    expect(el.querySelector('.overlay .overlay-probe')).not.toBeNull();
  });

  it('does not project unslotted content into the nav or overlay regions', () => {
    const fixture = render();
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('.nav .content-probe')).toBeNull();
    expect(el.querySelector('.overlay .content-probe')).toBeNull();
  });

  it('defaults to a top nav placement (row layout, not side rail)', () => {
    const fixture = render();
    expect(fixture.nativeElement.querySelector('.mui-app-shell.side-nav')).toBeNull();
  });

  it('switches to a side rail when navPlacement is "side"', () => {
    const fixture = render();
    fixture.componentInstance.placement.set('side');
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.mui-app-shell.side-nav')).not.toBeNull();
  });
});
