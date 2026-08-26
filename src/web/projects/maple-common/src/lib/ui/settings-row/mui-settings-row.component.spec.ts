import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import type { ComponentFixture } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';

import { MuiSettingsRowComponent } from './mui-settings-row.component';

@Component({
  standalone: true,
  imports: [MuiSettingsRowComponent],
  template: `
    <mui-settings-row label="Sync frequency" icon="history" description="How often to sync.">
      <div class="projected">Every 15 minutes</div>
    </mui-settings-row>
  `,
})
class HostComponent {}

function render(): ComponentFixture<HostComponent> {
  TestBed.configureTestingModule({ imports: [HostComponent] });
  const fixture = TestBed.createComponent(HostComponent);
  fixture.detectChanges();
  return fixture;
}

describe('MuiSettingsRowComponent', () => {
  it('starts collapsed and expands the projected content on header click', () => {
    const fixture = render();
    expect(fixture.nativeElement.querySelector('.content-wrapper').className).not.toContain('open');

    (fixture.nativeElement.querySelector('.header') as HTMLButtonElement).click();
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.content-wrapper').className).toContain('open');
    expect(fixture.nativeElement.querySelector('.projected').textContent).toBe('Every 15 minutes');
  });

  it('renders the leading icon and description', () => {
    const fixture = render();
    expect(fixture.nativeElement.querySelector('.leading-icon')).toBeTruthy();
    expect(fixture.nativeElement.textContent).toContain('How often to sync.');
  });

  it('renders a trailing divider by default', () => {
    const fixture = render();
    expect(fixture.nativeElement.querySelector('mui-divider')).toBeTruthy();
  });
});

@Component({
  standalone: true,
  imports: [MuiSettingsRowComponent],
  template: `
    <mui-settings-row [customSummary]="true" label="Stage: thumb" [open]="open">
      <div summary class="custom-header">thumb — running</div>
      <div class="projected-body">Concurrency: 4</div>
    </mui-settings-row>
  `,
})
class CustomSummaryHostComponent {
  open = false;
}

describe('MuiSettingsRowComponent (customSummary)', () => {
  function renderCustom(): ComponentFixture<CustomSummaryHostComponent> {
    TestBed.configureTestingModule({ imports: [CustomSummaryHostComponent] });
    const fixture = TestBed.createComponent(CustomSummaryHostComponent);
    fixture.detectChanges();
    return fixture;
  }

  it('projects the [summary] slot into the header instead of a plain label', () => {
    const fixture = renderCustom();
    expect(fixture.nativeElement.querySelector('.custom-header').textContent).toBe(
      'thumb — running',
    );
    // No collapsible label text rendered in this mode.
    expect(fixture.nativeElement.querySelector('mui-text')).toBeFalsy();
  });

  it('expands the projected body on header click, same as the default mode', () => {
    const fixture = renderCustom();
    expect(fixture.nativeElement.querySelector('.content-wrapper').className).not.toContain(
      'open',
    );

    (fixture.nativeElement.querySelector('.header') as HTMLButtonElement).click();
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.content-wrapper').className).toContain('open');
    expect(fixture.nativeElement.querySelector('.projected-body').textContent).toBe(
      'Concurrency: 4',
    );
  });

  it('sets the header button aria-label from `label`', () => {
    const fixture = renderCustom();
    expect(fixture.nativeElement.querySelector('.header').getAttribute('aria-label')).toBe(
      'Stage: thumb',
    );
  });
});

@Component({
  standalone: true,
  imports: [MuiSettingsRowComponent],
  template: `
    <mui-settings-row [customSummary]="true" label="Stage: thumb" [open]="open">
      <div summary>
        <button type="button" class="run-now" (click)="ran = true">Run now</button>
      </div>
    </mui-settings-row>
  `,
})
class NestedButtonHostComponent {
  open = false;
  ran = false;
}

describe('MuiSettingsRowComponent (customSummary nested-button guard)', () => {
  it('a click on a projected button in the summary activates the button, not the row toggle', () => {
    TestBed.configureTestingModule({ imports: [NestedButtonHostComponent] });
    const fixture = TestBed.createComponent(NestedButtonHostComponent);
    fixture.detectChanges();

    (fixture.nativeElement.querySelector('.run-now') as HTMLButtonElement).click();
    fixture.detectChanges();

    expect(fixture.componentInstance.ran).toBe(true);
    expect(fixture.nativeElement.querySelector('.content-wrapper').className).not.toContain(
      'open',
    );
  });
});
