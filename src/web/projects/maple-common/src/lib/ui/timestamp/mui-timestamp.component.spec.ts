import { TestBed } from '@angular/core/testing';
import type { ComponentFixture } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';

import { MuiTimestampComponent } from './mui-timestamp.component';

// Fixed reference instant — every relative-format assertion computes its
// `value` input as an offset from this, so the test never races the real
// clock.
const NOW = new Date('2026-08-22T12:00:00.000Z');

function render(
  value: Date | number | string,
  format: 'relative' | 'short' | 'long' | 'time-only' = 'relative',
): ComponentFixture<MuiTimestampComponent> {
  // Each call configures a fresh testing module — some tests call render()
  // more than once (comparing two formats/values within one `it()`), and
  // TestBed refuses to reconfigure once a component has been instantiated.
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({ imports: [MuiTimestampComponent] });
  const fixture = TestBed.createComponent(MuiTimestampComponent);
  fixture.componentRef.setInput('value', value);
  fixture.componentRef.setInput('format', format);
  fixture.componentRef.setInput('now', NOW);
  fixture.detectChanges();
  return fixture;
}

function time(fixture: ComponentFixture<MuiTimestampComponent>): HTMLTimeElement {
  return fixture.nativeElement.querySelector('time') as HTMLTimeElement;
}

describe('MuiTimestampComponent — relative format degradation', () => {
  it('shows "just now" under a minute', () => {
    const fixture = render(new Date(NOW.getTime() - 30_000));
    expect(time(fixture).textContent).toBe('just now');
  });

  it('degrades to Nm for minutes', () => {
    const fixture = render(new Date(NOW.getTime() - 5 * 60_000));
    expect(time(fixture).textContent).toBe('5m ago');
  });

  it('degrades to Nh for hours', () => {
    const fixture = render(new Date(NOW.getTime() - 3 * 60 * 60_000));
    expect(time(fixture).textContent).toBe('3h ago');
  });

  it('degrades to Nd for a handful of days', () => {
    const fixture = render(new Date(NOW.getTime() - 4 * 24 * 60 * 60_000));
    expect(time(fixture).textContent).toBe('4d ago');
  });

  it('falls back to an absolute date once past the relative ceiling', () => {
    const fixture = render(new Date(NOW.getTime() - 30 * 24 * 60 * 60_000));
    expect(time(fixture).textContent).toBe('Jul 23, 2026');
  });
});

describe('MuiTimestampComponent — absolute formats', () => {
  const target = new Date('2026-03-05T15:45:00.000Z');

  it('short: month day, year', () => {
    const fixture = render(target, 'short');
    expect(time(fixture).textContent).toMatch(/Mar 5, 2026/);
  });

  it('long: full month day, year, time', () => {
    const fixture = render(target, 'long');
    const text = time(fixture).textContent ?? '';
    expect(text).toContain('March 5, 2026');
  });

  it('time-only: just the clock time', () => {
    const fixture = render(target, 'time-only');
    const text = time(fixture).textContent ?? '';
    expect(text).not.toContain('2026');
    expect(text.length).toBeGreaterThan(0);
  });
});

describe('MuiTimestampComponent — tooltip and machine-readable datetime', () => {
  it('carries the full absolute date+time as the title attribute regardless of display format', () => {
    const fixture = render(new Date('2026-03-05T15:45:00.000Z'), 'relative');
    expect(time(fixture).title).toContain('March 5, 2026');
  });

  it('sets the datetime attribute to the ISO instant', () => {
    const target = new Date('2026-03-05T15:45:00.000Z');
    const fixture = render(target);
    expect(time(fixture).getAttribute('datetime')).toBe(target.toISOString());
  });

  it('accepts numeric epoch and ISO-string values, not just Date objects', () => {
    const target = new Date(NOW.getTime() - 60_000 * 5);
    const fromNumber = render(target.getTime());
    expect(time(fromNumber).textContent).toBe('5m ago');
    const fromString = render(target.toISOString());
    expect(time(fromString).textContent).toBe('5m ago');
  });
});
