import { TestBed } from '@angular/core/testing';
import type { ComponentFixture } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';

import { MuiStatusTextComponent } from './mui-status-text.component';

function make(): ComponentFixture<MuiStatusTextComponent> {
  TestBed.configureTestingModule({ imports: [MuiStatusTextComponent] });
  const fixture = TestBed.createComponent(MuiStatusTextComponent);
  fixture.componentRef.setInput('state', 'idle');
  fixture.detectChanges();
  return fixture;
}

describe('MuiStatusTextComponent', () => {
  it('renders the default text and icon per state', () => {
    const fixture = make();
    const cases: Array<[string, string]> = [
      ['idle', 'Idle'],
      ['saving', 'Saving…'],
      ['saved', 'Saved'],
      ['offline', 'Offline'],
      ['error', 'Error'],
    ];
    for (const [state, text] of cases) {
      fixture.componentRef.setInput('state', state);
      fixture.detectChanges();
      expect(fixture.nativeElement.querySelector('.text').textContent).toBe(text);
      expect(fixture.nativeElement.querySelector('mui-icon')).toBeTruthy();
    }
  });

  it('pairs each state with a distinct icon glyph', () => {
    const fixture = make();
    const icons = new Set<string>();
    for (const state of ['idle', 'saving', 'saved', 'offline', 'error']) {
      fixture.componentRef.setInput('state', state);
      fixture.detectChanges();
      icons.add(fixture.componentInstance.presentation().icon);
    }
    expect(icons.size).toBe(5);
  });

  it('lets `text` override the default per-state label', () => {
    const fixture = make();
    fixture.componentRef.setInput('state', 'saved');
    fixture.componentRef.setInput('text', 'Saved 2m ago');
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.text').textContent).toBe('Saved 2m ago');
  });

  it('exposes a status role for assistive tech, except error which is an alert', () => {
    const fixture = make();
    expect(fixture.nativeElement.querySelector('.mui-status-text').getAttribute('role')).toBe(
      'status',
    );

    fixture.componentRef.setInput('state', 'error');
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.mui-status-text').getAttribute('role')).toBe(
      'alert',
    );
  });
});
