import type { AiAssignment, AiConnection } from './ai-connections.ts';
import type { EmbedderSettingsInput } from './embedder-settings.ts';
import { embedderPatch } from './embedder-settings.ts';

type IncomingConnection = Omit<AiConnection, 'api_key'> & { api_key?: string | null };

const trimUrl = (url: string): string => url.trim().replace(/\/+$/, '');

/** A saved key stays only with its own provider and endpoint, so it is never sent to a new host. */
function savedKey(
  connection: { id: string; provider: string; url?: string },
  saved: readonly AiConnection[],
): string | null | undefined {
  return saved.find(
    (old) =>
      old.id === connection.id &&
      old.provider === connection.provider &&
      trimUrl(old.url) === trimUrl(connection.url ?? old.url),
  )?.api_key;
}

/** Trims names and URLs; an omitted key keeps the saved key of the same connection and endpoint. */
export function normalizeConnections(
  incoming: readonly IncomingConnection[],
  saved: readonly AiConnection[],
): AiConnection[] {
  return incoming.map((c) => ({
    ...c,
    name: c.name.trim(),
    url: trimUrl(c.url),
    api_key: c.api_key === undefined ? savedKey(c, saved) : c.api_key?.trim() || null,
  }));
}

function normalizeAssignment(a: AiAssignment): AiAssignment {
  const { connection_models: models } = a;
  return {
    ...a,
    model: a.model.trim(),
    ...(models
      ? {
          connection_models: Object.fromEntries(
            a.connection_ids.map((key) => [key, (models[key] ?? '').trim()]),
          ),
        }
      : {}),
  };
}

export function normalizeAssignments(
  incoming: Record<string, AiAssignment>,
): Record<string, AiAssignment> {
  return Object.fromEntries(
    Object.entries(incoming).map(([id, a]) => [id, normalizeAssignment(a)]),
  );
}

/** The embedder fields to save (none when omitted) or the validation error that blocks the save. */
export function embedderSaveOutcome(
  input: EmbedderSettingsInput | undefined,
): ReturnType<typeof embedderPatch> {
  return input === undefined ? {} : embedderPatch(input);
}

/** The key to probe with: the one sent, else the saved key of the same connection and endpoint. */
export function probeApiKey(
  connection: { id: string; provider: string; url?: string; api_key?: string | null },
  saved: readonly AiConnection[],
): string | null | undefined {
  return connection.api_key === undefined ? savedKey(connection, saved) : connection.api_key;
}

const OK_STATUS = 200;
const DEFAULT_FAILURE_STATUS = 400;

/** The HTTP status for a connection test result. */
export function probeFailureStatus(result: { ok: boolean; status?: number | null }): number {
  return result.ok ? OK_STATUS : (result.status ?? DEFAULT_FAILURE_STATUS);
}
