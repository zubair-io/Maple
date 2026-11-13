import { type Observable, catchError, expand, of, switchMap, timer } from 'rxjs';
import type { TemporalSettings, TemporalSettingsUpdate } from '@maple-common';

export const REPORT_POLL_MS = 2_000;
export const STEADY_POLL_MS = 10_000;

export interface TemporalConnectionView {
  label: string;
  color: string;
  detail: string;
}

const NOT_LOADED: TemporalConnectionView = {
  label: 'Not loaded',
  color: 'var(--s-text-dim)',
  detail: '',
};

function checkedLabel(checkedAt: number | null): string {
  if (checkedAt === null) return '';
  const at = new Date(checkedAt);
  return Number.isNaN(at.getTime()) ? '' : `Last checked ${at.toLocaleTimeString()}`;
}

export function connectionView(settings: TemporalSettings | null): TemporalConnectionView {
  if (!settings) return NOT_LOADED;
  const { state, error, checkedAt } = settings.connection;
  switch (state) {
    case 'connected':
      return { label: 'Connected', color: 'var(--s-ok)', detail: checkedLabel(checkedAt) };
    case 'unreachable':
      return {
        label: 'Unreachable',
        color: 'var(--s-err)',
        detail: error ?? 'Maple could not reach this Temporal server.',
      };
    case 'unknown':
      return {
        label: 'Connecting',
        color: 'var(--s-warn)',
        detail: 'Waiting for the worker to report on this address.',
      };
  }
}

export function summaryLine(settings: TemporalSettings | null): string {
  if (!settings) return '';
  const { state, error } = settings.connection;
  return state === 'unreachable' && error ? error : `${settings.address} · ${settings.namespace}`;
}

export function toUpdate(address: string, namespace: string): TemporalSettingsUpdate | null {
  const update = { address: address.trim(), namespace: namespace.trim() };
  return update.address.length > 0 && update.namespace.length > 0 ? update : null;
}

export function sameTarget(
  a: TemporalSettingsUpdate | null,
  b: TemporalSettingsUpdate | null,
): boolean {
  return a !== null && b !== null && a.address === b.address && a.namespace === b.namespace;
}

function pollDelayMs(settings: TemporalSettings): number {
  return settings.connection.state === 'unknown' ? REPORT_POLL_MS : STEADY_POLL_MS;
}

// A re-read that fails re-emits the last known settings so the watch keeps
// its cadence instead of ending on one dropped request.
export function watchConnection(
  first: Observable<TemporalSettings>,
  reread: () => Observable<TemporalSettings>,
): Observable<TemporalSettings> {
  return first.pipe(
    expand((latest) =>
      timer(pollDelayMs(latest)).pipe(switchMap(() => reread().pipe(catchError(() => of(latest))))),
    ),
  );
}
