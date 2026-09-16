import { assignmentModel, assignedAi, type AiConnectionsConfig } from './ai-connections.ts';
import { DescribeServerPool } from './describe-server-pool.ts';
import { getDescribeProvider } from './describe-providers/index.ts';

export function assignedAiPool(config: AiConnectionsConfig | undefined, worker: string) {
  const assigned = assignedAi(config, worker);
  if (!assigned) return null;
  const { primary, connections, model } = assigned;
  const servers = connections.map((c) => ({
    url: c.provider === 'ollama' ? c.url : c.id,
    concurrency: c.concurrency,
    model: assignmentModel(config!.assignments[worker]!, c.id),
    provider: c.provider,
  }));
  const pool = new DescribeServerPool(
    servers,
    (url) => {
      const connection = connections.find((c) => (c.provider === 'ollama' ? c.url : c.id) === url)!;
      return getDescribeProvider(connection.provider, {
        url: connection.url,
        apiKey: connection.api_key,
      });
    },
    {},
    true,
  );
  return { pool, model, provider: primary.provider };
}
