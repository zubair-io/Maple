import { setTimeout } from 'node:timers/promises';
import type { SessionClient } from '@google/jules-sdk';

type ReviewSession = Pick<SessionClient, 'id' | 'info' | 'history'> & {
  activities: Pick<SessionClient['activities'], 'hydrate'>;
};

// Match HTTP status codes, not digits embedded in a Jules session ID.
export function isAuthError(message: string): boolean {
  return /\b(?:401|403)\b/.test(message);
}

export async function pollForReview(session: ReviewSession, timeoutMs: number): Promise<string> {
  // Manual cleanup imports this module without installing action dependencies.
  // Load review-only dependencies when polling, keeping recovery standalone.
  const core = await import('@actions/core');
  const { AutomatedSessionFailedError } = await import('@google/jules-sdk');
  const deadline = Date.now() + timeoutMs;
  let attempt = 0;
  while (Date.now() < deadline) {
    attempt++;
    try {
      // Check state before activity I/O: a failed history/hydration request must
      // not hide an already terminal session behind the retry loop (#3994).
      const initial = await session.info();
      if (initial.state === 'failed') throw new AutomatedSessionFailedError();
      await session.activities.hydrate();
      let last = '';
      for await (const activity of session.history()) {
        if (activity.type === 'agentMessaged') last = activity.message;
      }
      const { state } = initial.state === 'completed' ? initial : await session.info();
      if (state === 'failed') throw new AutomatedSessionFailedError();
      if (isFinalReview(state, last)) {
        core.info(`Got agentMessaged on attempt ${attempt}.`);
        return last;
      }
      core.info(`No final review yet (attempt ${attempt})…`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (err instanceof AutomatedSessionFailedError) {
        throw new Error(
          `Jules review session ${session.id} failed. ` +
            `Inspect https://jules.google.com/session/${session.id}.`,
        );
      }
      if (isAuthError(message)) {
        throw new Error(`Jules API rejected request (${message}). Check JULES_API_KEY is valid.`);
      }
      core.info(`Review polling error (attempt ${attempt}): ${message}`);
    }
    await new Promise((resolve) => globalThis.setTimeout(resolve, 20_000));
  }
  return '';
}

export function isFinalReview(state: string, message: string): boolean {
  return state === 'completed' && /^`?VERDICT:\s*(approve|comment|block)`?\s*$/im.test(message);
}

export async function verifyPublishedSession(
  repo: string,
  prNumber: string,
  sessionId: string,
  githubToken: string,
  request: typeof fetch,
): Promise<void> {
  if (
    !/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(repo) ||
    !/^[1-9][0-9]*$/.test(prNumber) ||
    !/^[a-zA-Z0-9_-]+$/.test(sessionId)
  ) {
    throw new Error('Invalid cleanup target');
  }
  for (let page = 1; ; page++) {
    const response = await request(
      `https://api.github.com/repos/${repo}/issues/${prNumber}/comments?per_page=100&page=${page}`,
      {
        headers: { authorization: `Bearer ${githubToken}`, accept: 'application/vnd.github+json' },
        redirect: 'error',
        signal: AbortSignal.timeout(30_000),
      },
    );
    if (!response.ok) throw new Error(`Review verification failed (HTTP ${response.status})`);
    const comments = (await response.json()) as {
      user?: { login?: string };
      body?: string;
    }[];
    const published = comments.some(
      ({ user, body }) =>
        user?.login === 'github-actions[bot]' &&
        typeof body === 'string' &&
        body.startsWith('<!-- jules-pr-reviewer -->\n## 🤖 Jules Review\n') &&
        body.trimEnd().endsWith(`_Session: \`${sessionId}\`_`) &&
        isFinalReview('completed', body),
    );
    if (published) return;
    if (comments.length < 100) throw new Error('No completed review published for this session');
  }
}

export async function publishThenDelete(
  sessionId: string,
  apiKey: string,
  publish: () => Promise<void>,
  request: typeof fetch,
  cleanupFailed: (message: string) => void,
): Promise<void> {
  await publish();
  if (!/^[a-zA-Z0-9_-]+$/.test(sessionId)) {
    cleanupFailed('Review saved, but Jules cleanup received an invalid session ID.');
    return;
  }
  for (let attempt = 1; attempt <= 3; attempt++) {
    const failure = await deleteAttempt(sessionId, apiKey, request);
    if (failure === null) return;
    if (!failure.retry || attempt === 3) {
      cleanupFailed(
        `Review saved, but Jules session ${sessionId} could not be deleted (${failure.reason}; ${attempt} attempt${attempt === 1 ? '' : 's'}). Retry cleanup using the documented REST API command.`,
      );
      return;
    }
    await setTimeout(attempt * 1_000);
  }
}

async function deleteAttempt(
  sessionId: string,
  apiKey: string,
  request: typeof fetch,
): Promise<{ reason: string; retry: boolean } | null> {
  try {
    const response = await request(`https://jules.googleapis.com/v1alpha/sessions/${sessionId}`, {
      method: 'DELETE',
      headers: { 'x-goog-api-key': apiKey },
      redirect: 'error',
      signal: AbortSignal.timeout(30_000),
    });
    if (response.ok || response.status === 404) return null;
    return {
      reason: `HTTP ${response.status}`,
      retry: response.status === 408 || response.status === 429 || response.status >= 500,
    };
  } catch (error) {
    const timeout =
      error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
    return { reason: timeout ? 'request timed out' : 'network request failed', retry: true };
  }
}
