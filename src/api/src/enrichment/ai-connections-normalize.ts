import type { AiAssignment, AiConnection } from './ai-connections.ts';
import type { EmbedderSettingsInput } from './embedder-settings.ts';
import { embedderPatch } from './embedder-settings.ts';

type IncomingConnection = Omit<AiConnection, 'api_key'> & { api_key?: string | null };

/** Trims names and URLs; an omitted key keeps the saved key of the same connection. */
export function normalizeConnections(
  incoming: readonly IncomingConnection[],
  saved: readonly AiConnection[],
): AiConnection[] {
  return incoming.map((c) => ({
    ...c,
    name: c.name.trim(),
    url: c.url.trim().replace(/\/+$/, ''),
    api_key:
      c.api_key === undefined
        ? saved.find((old) => old.id === c.id && old.provider === c.provider)?.api_key
        : c.api_key?.trim() || null,
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
