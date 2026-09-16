import { assignmentModel, type AiConnectionsConfig } from './ai-connections.ts';
import { listProviderModels } from './ai-providers.service.ts';

/** Validate changed cloud assignments against the selected account, never fallback suggestions. */
export async function validateAssignedModels(
  config: AiConnectionsConfig,
  current: AiConnectionsConfig,
): Promise<string | null> {
  for (const connection of config.connections) {
    if (connection.provider === 'ollama') continue;
    const old = current.connections.find((c) => c.id === connection.id);
    const changed = Object.entries(config.assignments).filter(([worker, a]) => {
      if (!a.connection_ids.includes(connection.id)) return false;
      const previous = current.assignments[worker];
      return (
        old?.provider !== connection.provider ||
        old?.api_key !== connection.api_key ||
        !previous ||
        assignmentModel(previous, connection.id) !== assignmentModel(a, connection.id) ||
        !previous?.connection_ids.includes(connection.id)
      );
    });
    if (!changed.length) continue;
    const result = await listProviderModels(connection.provider, { apiKey: connection.api_key });
    if (result.source !== 'live')
      return `Could not verify models for ${connection.name}. ${result.error ?? 'Try again.'}`;
    const invalid = changed.find(
      ([, a]) => !result.models.includes(assignmentModel(a, connection.id)),
    );
    if (invalid)
      return `${invalid[0]}: ${assignmentModel(invalid[1], connection.id)} is not available from ${connection.name} (${connection.provider}). Select a model from this provider.`;
  }
  return null;
}
