export type FailOn = 'never' | 'blocking' | 'any';
export type Verdict = 'approve' | 'comment' | 'block';
export type StatusState = 'success' | 'failure' | 'error';

export type ReviewResult =
  | { kind: 'verdict'; verdict: Verdict; failOn: FailOn }
  | { kind: 'timeout'; minutes: number }
  | { kind: 'failure'; error: unknown };

export interface Outcome {
  state: StatusState;
  description: string;
  failJob: boolean;
}

const STATUS_DESCRIPTION_MAX = 140;

export function parseVerdict(message: string): Verdict {
  const match = message.match(/VERDICT:\s*(approve|comment|block)/i);
  if (match) return match[1].toLowerCase() as Verdict;
  if (/\[BLOCKING\]/.test(message)) return 'block';
  return 'comment';
}

// Bad credentials or missing token permissions are misconfiguration the operator must fix;
// everything else a review run can hit (quota, timeouts, 5xx, a failed session) is the bot's
// infrastructure and must not hold up a PR.
export function isInfrastructureFailure(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return !(/\b(?:401|403)\b/.test(message) || message.includes('Resource not accessible'));
}

export function resolveOutcome(result: ReviewResult): Outcome {
  if (result.kind === 'verdict') return verdictOutcome(result.verdict, result.failOn);
  if (result.kind === 'timeout') {
    return skipped(`Jules returned no review within ${result.minutes} minutes`);
  }
  const message = result.error instanceof Error ? result.error.message : String(result.error);
  return isInfrastructureFailure(result.error)
    ? skipped(message)
    : { state: 'error', description: truncate(message), failJob: true };
}

function verdictOutcome(verdict: Verdict, failOn: FailOn): Outcome {
  const failed =
    failOn === 'any' ? verdict !== 'approve' : failOn === 'blocking' && verdict === 'block';
  if (failed) {
    return {
      state: 'failure',
      description: verdict === 'block' ? 'Blocking issues found' : `Review verdict: ${verdict}`,
      failJob: false,
    };
  }
  return {
    state: 'success',
    description:
      verdict === 'approve' && failOn === 'any'
        ? 'Approved'
        : `Review complete (verdict: ${verdict})`,
    failJob: false,
  };
}

function skipped(reason: string): Outcome {
  return {
    state: 'success',
    description: truncate(`Review not blocking: bot unavailable (${reason})`),
    failJob: false,
  };
}

function truncate(text: string): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length <= STATUS_DESCRIPTION_MAX
    ? oneLine
    : oneLine.slice(0, STATUS_DESCRIPTION_MAX - 1) + '…';
}
