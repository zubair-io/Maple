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

const AUTH_MESSAGE =
  /\b(?:401|403)\b|bad credentials|unauthenticated|unauthorized|permission[_ ]denied|api key not valid|invalid api key|resource not accessible|check jules_api_key/i;

function statusOf(error: unknown): unknown {
  if (typeof error !== 'object' || error === null) return undefined;
  const { status, response } = error as { status?: unknown; response?: { status?: unknown } };
  return status ?? response?.status;
}

// Bad credentials or missing token permissions are misconfiguration the operator must fix;
// everything else a review run can hit (quota, timeouts, 5xx, a failed session) is the bot's
// infrastructure and must not hold up a PR. Mirrors isAuthError in cleanup.ts, which cannot
// import this module because manual recovery runs it standalone.
export function isAuthFailure(error: unknown): boolean {
  const status = Number(statusOf(error));
  if (status === 401 || status === 403) return true;
  return AUTH_MESSAGE.test(error instanceof Error ? error.message : String(error));
}

export function isInfrastructureFailure(error: unknown): boolean {
  return !isAuthFailure(error);
}

const STATUS_WRITE_ATTEMPTS = 3;

// A produced verdict is the source of truth: never replace it with an infrastructure skip.
// Retry only the status write; if that cannot be done, fail the job loudly instead.
export async function settleFailure(
  error: unknown,
  produced: Outcome | undefined,
  writeStatus: (outcome: Outcome) => Promise<void>,
  pause: (attempt: number) => Promise<void> = () => Promise.resolve(),
): Promise<Outcome> {
  const outcome = produced ?? resolveOutcome({ kind: 'failure', error });
  for (let attempt = 1; attempt <= STATUS_WRITE_ATTEMPTS; attempt++) {
    try {
      await writeStatus(outcome);
      return outcome;
    } catch {
      await pause(attempt);
    }
  }
  const reason = error instanceof Error ? error.message : String(error);
  return {
    state: outcome.state === 'success' ? 'error' : outcome.state,
    description: truncate(`Review status could not be written (${reason})`),
    failJob: true,
  };
}

export function resolveOutcome(result: ReviewResult): Outcome {
  if (result.kind === 'verdict') return verdictOutcome(result.verdict, result.failOn);
  if (result.kind === 'timeout') {
    return skipped(`Jules returned no review within ${result.minutes} minutes`);
  }
  const message = result.error instanceof Error ? result.error.message : String(result.error);
  return isInfrastructureFailure(result.error)
    ? skipped(describeInfrastructureFailure(message))
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

// Jules answers a session-creation request past its rolling daily task allowance with a bare
// HTTP 400 FAILED_PRECONDITION ("Precondition check failed."), indistinguishable from a source
// precondition, so name both rather than asserting one.
const QUOTA_OR_PRECONDITION =
  /FAILED_PRECONDITION|Precondition check failed|RESOURCE_EXHAUSTED|\b429\b|quota/i;

function describeInfrastructureFailure(message: string): string {
  return QUOTA_OR_PRECONDITION.test(message)
    ? `Jules account quota or source precondition (${/RESOURCE_EXHAUSTED|\b429\b/i.test(message) ? 'quota' : 'FAILED_PRECONDITION'}); no review`
    : message;
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
