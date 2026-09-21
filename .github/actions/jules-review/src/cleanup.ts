export function isFinalReview(state: string, message: string): boolean {
  return state === 'completed' && /^`?VERDICT:\s*(approve|comment|block)`?\s*$/im.test(message);
}

export async function publishThenDelete(
  sessionId: string,
  apiKey: string,
  publish: () => Promise<void>,
  request: typeof fetch,
  cleanupFailed: (message: string) => void,
): Promise<void> {
  await publish();
  try {
    if (!/^[a-zA-Z0-9_-]+$/.test(sessionId)) throw new Error('Invalid session ID');
    const response = await request(`https://jules.googleapis.com/v1alpha/sessions/${sessionId}`, {
      method: 'DELETE',
      headers: { 'x-goog-api-key': apiKey },
      redirect: 'error',
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok && response.status !== 404) {
      // Do not echo upstream response bodies, which may contain sensitive data.
      throw new Error(`HTTP ${response.status}`);
    }
  } catch {
    cleanupFailed(
      `Review saved, but Jules session ${sessionId} could not be deleted. Retry cleanup using the documented REST API command.`,
    );
  }
}
