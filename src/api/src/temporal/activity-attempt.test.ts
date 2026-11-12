import { describe, expect, test } from 'bun:test';
import { attemptStop } from './activity-attempt.ts';

const details = (reason: Partial<NonNullable<Parameters<typeof attemptStop>[0]>>) => ({
  notFound: false,
  cancelRequested: false,
  paused: false,
  timedOut: false,
  workerShutdown: false,
  reset: false,
  ...reason,
});

describe('attemptStop', () => {
  test('nothing asked for, nothing to do', () => {
    expect(attemptStop(undefined)).toBeNull();
  });

  test.each(['workerShutdown', 'timedOut', 'notFound'] as const)(
    '%s leaves the handler running',
    (reason) => {
      expect(attemptStop(details({ [reason]: true }))).toBeNull();
    },
  );

  test('a cancel made in Temporal cancels the job', () => {
    expect(attemptStop(details({ cancelRequested: true }))).toBe('cancel');
    expect(attemptStop(details({ cancelRequested: true, workerShutdown: true }))).toBe('cancel');
  });

  test.each(['paused', 'reset'] as const)('%s stops the attempt for a later one', (reason) => {
    expect(attemptStop(details({ [reason]: true }))).toBe('superseded');
  });
});
