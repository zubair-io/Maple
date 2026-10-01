import { setTimeout } from 'node:timers/promises';

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
