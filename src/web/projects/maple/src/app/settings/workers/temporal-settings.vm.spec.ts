import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { of, throwError } from 'rxjs';
import type { TemporalSettings } from '@maple-common';
import {
  REPORT_POLL_MS,
  STEADY_POLL_MS,
  connectionView,
  sameTarget,
  summaryLine,
  toUpdate,
  watchConnection,
} from './temporal-settings.vm';

const settings = (
  state: TemporalSettings['connection']['state'],
  error: string | null = null,
  checkedAt: number | null = null,
): TemporalSettings => ({
  address: 'temporal:7233',
  namespace: 'maple',
  connection: { state, error, checkedAt },
});

describe('connectionView', () => {
  it('reads "Not loaded" before the first response', () => {
    expect(connectionView(null).label).toBe('Not loaded');
  });

  it('reports a connected server with when it was last checked', () => {
    const view = connectionView(settings('connected', null, 1_780_000_000_000));
    expect(view.label).toBe('Connected');
    expect(view.color).toBe('var(--s-ok)');
    expect(view.detail).toContain('Last checked');
  });

  it('reports an unreachable server with the reason the worker gave', () => {
    const view = connectionView(settings('unreachable', 'connect ECONNREFUSED temporal:7233'));
    expect(view.label).toBe('Unreachable');
    expect(view.color).toBe('var(--s-err)');
    expect(view.detail).toBe('connect ECONNREFUSED temporal:7233');
  });

  it('still explains an unreachable server that came with no reason', () => {
    expect(connectionView(settings('unreachable')).detail).not.toBe('');
  });

  it('reads "Connecting" while the worker has not reported on the saved address', () => {
    const view = connectionView(settings('unknown'));
    expect(view.label).toBe('Connecting');
    expect(view.color).toBe('var(--s-warn)');
  });
});

describe('summaryLine', () => {
  it('is empty before the first response', () => {
    expect(summaryLine(null)).toBe('');
  });

  it('shows where Maple is pointed', () => {
    expect(summaryLine(settings('connected'))).toBe('temporal:7233 · maple');
    expect(summaryLine(settings('unknown'))).toBe('temporal:7233 · maple');
  });

  it('shows the failure reason while unreachable, falling back to the address', () => {
    expect(summaryLine(settings('unreachable', 'deadline exceeded'))).toBe('deadline exceeded');
    expect(summaryLine(settings('unreachable'))).toBe('temporal:7233 · maple');
  });
});

describe('toUpdate', () => {
  it('trims both fields', () => {
    expect(toUpdate('  temporal:7233 ', ' maple  ')).toEqual({
      address: 'temporal:7233',
      namespace: 'maple',
    });
  });

  it('refuses a blank address or namespace', () => {
    expect(toUpdate('   ', 'maple')).toBeNull();
    expect(toUpdate('temporal:7233', '')).toBeNull();
  });
});

describe('sameTarget', () => {
  const target = { address: 'temporal:7233', namespace: 'maple' };

  it('matches the same address and namespace', () => {
    expect(sameTarget(target, { ...target })).toBe(true);
  });

  it('does not match a different field or a missing side', () => {
    expect(sameTarget(target, { ...target, address: 'temporal:7234' })).toBe(false);
    expect(sameTarget(target, { ...target, namespace: 'default' })).toBe(false);
    expect(sameTarget(target, null)).toBe(false);
    expect(sameTarget(null, null)).toBe(false);
  });
});

describe('watchConnection', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const watch = (first: TemporalSettings, answers: TemporalSettings[]) => {
    const reread = vi.fn(() => of(answers.shift() as TemporalSettings));
    const seen: string[] = [];
    const sub = watchConnection(of(first), reread).subscribe((s) => seen.push(s.connection.state));
    return { reread, seen, sub };
  };

  it('re-reads quickly while the worker has not reported, then slows down', () => {
    const { reread, seen, sub } = watch(settings('unknown'), [
      settings('unknown'),
      settings('connected'),
      settings('connected'),
    ]);

    expect(seen).toEqual(['unknown']);
    vi.advanceTimersByTime(REPORT_POLL_MS - 1);
    expect(reread).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(seen).toEqual(['unknown', 'unknown']);

    vi.advanceTimersByTime(REPORT_POLL_MS);
    expect(seen).toEqual(['unknown', 'unknown', 'connected']);

    vi.advanceTimersByTime(STEADY_POLL_MS - 1);
    expect(reread).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(1);
    expect(reread).toHaveBeenCalledTimes(3);
    sub.unsubscribe();
  });

  it('keeps re-reading a reported state, so a server that goes down or recovers shows up', () => {
    const { seen, sub } = watch(settings('connected'), [
      settings('unreachable', 'refused'),
      settings('connected'),
    ]);

    vi.advanceTimersByTime(STEADY_POLL_MS);
    expect(seen).toEqual(['connected', 'unreachable']);

    vi.advanceTimersByTime(STEADY_POLL_MS);
    expect(seen).toEqual(['connected', 'unreachable', 'connected']);
    sub.unsubscribe();
  });

  it('goes back to the quick cadence when the state returns to unknown', () => {
    const { reread, sub } = watch(settings('connected'), [
      settings('unknown'),
      settings('connected'),
    ]);

    vi.advanceTimersByTime(STEADY_POLL_MS);
    expect(reread).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(REPORT_POLL_MS);
    expect(reread).toHaveBeenCalledTimes(2);
    sub.unsubscribe();
  });

  it('survives a failed re-read: keeps the last state and tries again', () => {
    const answers = [
      throwError(() => new Error('offline')),
      of(settings('unreachable', 'refused')),
    ];
    const reread = vi.fn(() => answers.shift() ?? of(settings('connected')));
    const seen: string[] = [];
    let failed = false;
    const sub = watchConnection(of(settings('connected')), reread).subscribe({
      next: (s) => seen.push(s.connection.state),
      error: () => (failed = true),
    });

    vi.advanceTimersByTime(STEADY_POLL_MS);
    expect(failed).toBe(false);
    expect(seen).toEqual(['connected', 'connected']);

    vi.advanceTimersByTime(STEADY_POLL_MS);
    expect(seen).toEqual(['connected', 'connected', 'unreachable']);
    sub.unsubscribe();
  });

  it('reports a failed first read to the caller', () => {
    const reread = vi.fn(() => of(settings('connected')));
    let failure: unknown = null;
    watchConnection(
      throwError(() => new Error('forbidden')),
      reread,
    ).subscribe({ error: (e: unknown) => (failure = e) });

    vi.advanceTimersByTime(STEADY_POLL_MS * 3);
    expect(failure).toBeInstanceOf(Error);
    expect(reread).not.toHaveBeenCalled();
  });

  it('stops re-reading when unsubscribed', () => {
    const { reread, sub } = watch(settings('connected'), []);
    sub.unsubscribe();

    vi.advanceTimersByTime(STEADY_POLL_MS * 5);
    expect(reread).not.toHaveBeenCalled();
  });
});
