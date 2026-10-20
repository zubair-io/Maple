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

const NESTED_ERROR_KEYS = ['response', 'data', 'error', 'cause'] as const;
const MAX_ERROR_DEPTH = 5;

function hasAuthStatus(error: unknown, depth = 0, seen = new Set<unknown>()): boolean {
  if (typeof error !== 'object' || error === null || depth > MAX_ERROR_DEPTH || seen.has(error)) {
    return false;
  }
  seen.add(error);
  const record = error as Record<string, unknown>;
  const status = Number(record.status);
  return (
    status === 401 ||
    status === 403 ||
    NESTED_ERROR_KEYS.some((key) => hasAuthStatus(record[key], depth + 1, seen))
  );
}

// Bad credentials or missing token permissions are misconfiguration the operator must fix;
// everything else a review run can hit (quota, timeouts, 5xx, a failed session) is the bot's
// infrastructure and must not hold up a PR. Mirrors isAuthError in cleanup.ts, which cannot
// import this module because manual recovery runs it standalone.
export function isAuthFailure(error: unknown): boolean {
  return hasAuthStatus(error) || AUTH_MESSAGE.test(errorText(error));
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
  const message = errorText(result.error);
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

// Jules signals an exhausted daily task allowance as a bare 400 FAILED_PRECONDITION, so the reason names both causes.
const PRECONDITION = /FAILED[_ ]PRECONDITION|Precondition check failed/i;
const QUOTA =
  /RESOURCE[_ ]EXHAUSTED|\bHTTP\s*429\b|\bstatus:?\s*429\b|too many requests|\bquota\b/i;

function describeInfrastructureFailure(message: string): string {
  const label = PRECONDITION.test(message)
    ? 'FAILED_PRECONDITION'
    : QUOTA.test(message)
      ? 'quota'
      : '';
  return label ? `Jules account quota or source precondition (${label}); no review` : message;
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
