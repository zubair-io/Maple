export interface MeilisearchFailureDetails {
  status: number | null;
  code: string | null;
  type: string | null;
  message: string;
}

function failureField(
  source: Record<string, unknown>,
  key: string,
  maxLength: number,
): string | null {
  const value = source[key];
  if (typeof value !== 'string') return null;
  const cleaned = value.replace(/\s+/g, ' ').trim();
  return cleaned.length > 0 ? cleaned.slice(0, maxLength) : null;
}

function failureDetails(status: number, errorText: string | null): MeilisearchFailureDetails {
  let payload: Record<string, unknown> = {};
  if (errorText) {
    try {
      const parsed = JSON.parse(errorText) as unknown;
      if (parsed && typeof parsed === 'object') payload = parsed as Record<string, unknown>;
    } catch {
      payload = {};
    }
  }
  const fallbackMessage = errorText?.replace(/\s+/g, ' ').trim().slice(0, 1000);
  const message =
    failureField(payload, 'message', 1000) ??
    failureField(payload, 'error', 1000) ??
    fallbackMessage;
  return {
    status: status > 0 ? status : null,
    code: failureField(payload, 'code', 100),
    type: failureField(payload, 'type', 100),
    message: message || 'Meilisearch search request failed',
  };
}

export class MeilisearchSearchError extends Error {
  readonly details: MeilisearchFailureDetails;

  constructor(status: number, errorText: string | null) {
    const details = failureDetails(status, errorText);
    super(`meilisearch search failed: ${details.message}`);
    this.name = 'MeilisearchSearchError';
    this.details = details;
  }
}
