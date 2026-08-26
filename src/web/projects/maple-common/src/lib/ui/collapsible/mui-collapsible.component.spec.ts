import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import type { ComponentFixture } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

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

  it('pads its content region by default, and can opt out via padInner', () => {
    const fixture = render();
    expect(fixture.nativeElement.querySelector('.content-inner').className).toContain('pad-inner');
  });
});

@Component({
  standalone: true,
  imports: [MuiCollapsibleComponent],
  template: `
    <mui-collapsible label="Tone" storageKey="pad-inner-test" [padInner]="false">
      <p class="body">Body content</p>
    </mui-collapsible>
  `,
})
class NoPadHostComponent {}

describe('MuiCollapsibleComponent — padInner opt-out', () => {
  it('omits the padding class when padInner is false', () => {
    TestBed.configureTestingModule({ imports: [NoPadHostComponent] });
    const fixture = TestBed.createComponent(NoPadHostComponent);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.content-inner').className).not.toContain(
      'pad-inner',
    );
  });
});

@Component({
  standalone: true,
  imports: [MuiCollapsibleComponent],
  template: `<mui-collapsible label="Noise Reduction" storageKey="test-storage-key" />`,
})
class StorageHostComponent {}

describe('MuiCollapsibleComponent — storageKey persistence', () => {
  beforeEach(() => localStorage.removeItem('cm.coll.test-storage-key'));
  afterEach(() => localStorage.removeItem('cm.coll.test-storage-key'));

  it('defaults open (defaultOpen defaults to true) when nothing is stored yet', () => {
    TestBed.configureTestingModule({ imports: [StorageHostComponent] });
    const fixture = TestBed.createComponent(StorageHostComponent);
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('.header').getAttribute('aria-expanded')).toBe(
      'true',
    );
  });

  it('honors an explicit defaultOpen=false when nothing is stored yet', () => {
    TestBed.configureTestingModule({
      imports: [MuiCollapsibleComponent],
    });
    const fixture = TestBed.createComponent(MuiCollapsibleComponent);
    fixture.componentRef.setInput('label', 'Sharpening');
    fixture.componentRef.setInput('storageKey', 'test-storage-key');
    fixture.componentRef.setInput('defaultOpen', false);
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('.header').getAttribute('aria-expanded')).toBe(
      'false',
    );
  });

  it('restores a previously persisted closed state and persists toggles', () => {
    localStorage.setItem('cm.coll.test-storage-key', '0');
    TestBed.configureTestingModule({ imports: [StorageHostComponent] });
    const fixture = TestBed.createComponent(StorageHostComponent);
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('.header').getAttribute('aria-expanded')).toBe(
      'false',
    );

    fixture.nativeElement.querySelector('.header').click();
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('.header').getAttribute('aria-expanded')).toBe(
      'true',
    );
    expect(localStorage.getItem('cm.coll.test-storage-key')).toBe('1');
  });
});
