import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import type { ComponentFixture } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';

import { MuiCollapsibleComponent } from './mui-collapsible.component';

@Component({
  standalone: true,
  imports: [MuiCollapsibleComponent],
  template: `
    <mui-collapsible label="Advanced" [(open)]="open">
      <p class="body">Body content</p>
    </mui-collapsible>
  `,
})
class HostComponent {
  readonly open = signal(false);
}

function render(): ComponentFixture<HostComponent> {
  TestBed.configureTestingModule({ imports: [HostComponent] });
  const fixture = TestBed.createComponent(HostComponent);
  fixture.detectChanges();
  return fixture;
}

describe('MuiCollapsibleComponent', () => {
  it('starts collapsed: aria-expanded false, no open class on the content region', () => {
    const fixture = render();
    const header = fixture.nativeElement.querySelector('.header');
    expect(header.getAttribute('aria-expanded')).toBe('false');
    expect(fixture.nativeElement.querySelector('.content-wrapper').className).not.toContain('open');
  });

  it('expands on header click and updates the two-way open model', () => {
    const fixture = render();
    fixture.nativeElement.querySelector('.header').click();
    fixture.detectChanges();

    expect(fixture.componentInstance.open()).toBe(true);
    expect(fixture.nativeElement.querySelector('.header').getAttribute('aria-expanded')).toBe(
      'true',
    );
    expect(fixture.nativeElement.querySelector('.content-wrapper').className).toContain('open');
    expect(fixture.nativeElement.querySelector('.chevron').className).toContain('open');
  });

  it('collapses again on a second click', () => {
    const fixture = render();
    const header = fixture.nativeElement.querySelector('.header');
    header.click();
    fixture.detectChanges();
    header.click();
    fixture.detectChanges();

    expect(fixture.componentInstance.open()).toBe(false);
    expect(fixture.nativeElement.querySelector('.content-wrapper').className).not.toContain('open');
  });

  it('reflects an externally set open model without a click', () => {
    const fixture = render();
    fixture.componentInstance.open.set(true);
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('.header').getAttribute('aria-expanded')).toBe(
      'true',
    );
  });

  it('always projects its content, even while collapsed (height animates, not display)', () => {
    const fixture = render();
    expect(fixture.nativeElement.querySelector('.body').textContent).toBe('Body content');
  });
});
