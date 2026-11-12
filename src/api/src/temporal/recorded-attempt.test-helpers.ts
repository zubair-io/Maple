import type { AttemptStop, RowAttempt } from './activity-attempt.ts';

/** An activity attempt with no Temporal behind it: it records heartbeats and stops when told to. */
export interface RecordedAttempt extends RowAttempt {
  beats: { current: number; total: number }[];
  stop: AttemptStop | null;
}

export function recordedAttempt(identity: string): RecordedAttempt {
  const recorded: RecordedAttempt = {
    identity,
    beats: [],
    stop: null,
    heartbeat: (progress) => {
      recorded.beats.push(progress);
    },
    stopReason: () => recorded.stop,
  };
  return recorded;
}
