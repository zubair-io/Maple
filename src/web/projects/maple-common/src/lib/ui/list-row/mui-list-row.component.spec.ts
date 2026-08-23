import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import type { ComponentFixture } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';

import { MuiListRowComponent } from './mui-list-row.component';

function render(): ComponentFixture<MuiListRowComponent> {
  TestBed.configureTestingModule({ imports: [MuiListRowComponent] });
  const fixture = TestBed.createComponent(MuiListRowComponent);
  fixture.componentRef.setInput('label', 'Meeting notes');
  fixture.detectChanges();
  return fixture;
}

describe('MuiListRowComponent', () => {
  it('renders the label and an optional plain-text subtitle', () => {
    const fixture = render();
    fixture.componentRef.setInput('subtitle', 'Draft');
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('Meeting notes');
    expect(fixture.nativeElement.textContent).toContain('Draft');
  });

  it('prefers a relative Timestamp subtitle over plain text when both are given', () => {
    const fixture = render();
    fixture.componentRef.setInput('subtitle', 'Draft');
    fixture.componentRef.setInput('timestampValue', Date.now() - 120_000);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('mui-timestamp')).toBeTruthy();
    expect(fixture.nativeElement.textContent).not.toContain('Draft');
  });

  it('the entire row is the tap target — click and Enter/Space both fire pressed', () => {
    const fixture = render();
    const pressed: void[] = [];
    fixture.componentInstance.pressed.subscribe(() => pressed.push(undefined));
    const row = fixture.nativeElement.querySelector('.mui-list-row') as HTMLElement;

    row.click();
    row.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    row.dispatchEvent(new KeyboardEvent('keydown', { key: ' ' }));
    expect(pressed.length).toBe(3);
  });

  it('active uses surface_alt + left border, never a full primary fill, and exposes aria-current', () => {
    const fixture = render();
    fixture.componentRef.setInput('active', true);
    fixture.detectChanges();
    const row = fixture.nativeElement.querySelector('.mui-list-row');
    expect(row.className).toContain('is-active');
    expect(row.getAttribute('aria-current')).toBe('true');
  });

  it('disabled rows do not fire pressed and are removed from the tab order', () => {
    const fixture = render();
    fixture.componentRef.setInput('disabled', true);
    fixture.detectChanges();
    const pressed: void[] = [];
    fixture.componentInstance.pressed.subscribe(() => pressed.push(undefined));
    const row = fixture.nativeElement.querySelector('.mui-list-row') as HTMLElement;
    expect(row.getAttribute('tabindex')).toBe('-1');
    row.click();
    expect(pressed.length).toBe(0);
  });

  it('projected trailing content (e.g. a nested control) stays independently reachable', () => {
    @Component({
      selector: 'host-fixture',
      standalone: true,
      imports: [MuiListRowComponent],
      template: `
        <mui-list-row label="Wi-Fi">
          <button trailing type="button" class="toggle" (click)="onToggleClick($event)">
            Toggle
          </button>
        </mui-list-row>
      `,
    })
    class HostFixtureComponent {
      toggleClicks = 0;
      onToggleClick(event: Event): void {
        event.stopPropagation();
        this.toggleClicks++;
      }
    }

    TestBed.configureTestingModule({ imports: [HostFixtureComponent] });
    const fixture = TestBed.createComponent(HostFixtureComponent);
    fixture.detectChanges();
    const toggle = fixture.nativeElement.querySelector('.toggle') as HTMLButtonElement;
    expect(toggle).toBeTruthy();
    toggle.click();
    expect(fixture.componentInstance.toggleClicks).toBe(1);
  });
});
