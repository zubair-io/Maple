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
