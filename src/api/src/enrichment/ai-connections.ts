/** Saved connections are reusable; each worker owns its model and connection selection. */
import type { DescribeProviderName } from './describe-providers/index.ts';
import type { ResolvedEnrichmentConfig } from './enrichment-config.resolve.ts';
import type { WorkerConfig } from '../workers/stage-config.ts';

export interface AiConnection {
  id: string;
  name: string;
  provider: DescribeProviderName;
  url: string;
  concurrency: number;
  api_key?: string | null;
}
export interface AiAssignment {
  connection_ids: string[];
  model: string;
  connection_models?: Record<string, string>;
}
export interface AiConnectionsConfig {
  connections: AiConnection[];
  assignments: Record<string, AiAssignment>;
}
const AI_WORKERS = [
  {
    id: 'describe',
    name: 'Describe',
    detail: 'Image captions and OCR',
    multiple: true,
    providers: ['ollama', 'openai', 'anthropic', 'gemini'],
  },
  {
    id: 'video-describe',
    name: 'Video Describe',
    detail: 'Multi-frame video summaries',
    multiple: true,
    providers: ['ollama', 'openai', 'anthropic', 'gemini'],
  },
  {
    id: 'generated-search',
    name: 'Generated search',
    detail: 'Curated search collections · Ollama text generation',
    multiple: false,
    providers: ['ollama'],
  },
  {
    id: 'semantic-search',
    name: 'Semantic search',
    detail:
      'Document embeddings · Ollama or OpenAI-compatible embedding model · a changed connection or model reaches the search index only via Apply to index on Settings → Workers, which re-embeds every document',
    multiple: false,
    providers: ['ollama', 'openai'],
  },
];

/** Read-time import keeps upgrades non-destructive. First save snapshots independent assignments. */
export function importAiConnections(
  cfg: ResolvedEnrichmentConfig,
  describe: WorkerConfig | null,
  video: WorkerConfig | null,
  generatedModel: string,
): AiConnectionsConfig {
  const connections: AiConnection[] = cfg.describe_servers.map((server, i) => ({
    id: `ollama-${i + 1}`,
    name: `Ollama ${i + 1}`,
    provider: 'ollama',
    url: server.url,
    concurrency:
      cfg.source.describe_servers === 'derived'
        ? (describe?.concurrency ?? server.concurrency)
        : server.concurrency,
  }));
  for (const provider of ['openai', 'anthropic', 'gemini'] as const) {
    const key = cfg[`${provider}_api_key`];
    if (
      key ||
      cfg.describe_provider === provider ||
      video?.ai_provider === provider ||
      describe?.ai_provider === provider
    ) {
      connections.push({
        id: provider,
        name: provider,
        provider,
        url: '',
        concurrency: 2,
        api_key: key,
      });
    }
  }
  const assignment = (worker: WorkerConfig | null): AiAssignment => {
    const provider = worker?.ai_provider || cfg.describe_provider;
    return {
      connection_ids: connections.filter((c) => c.provider === provider).map((c) => c.id),
      model: worker?.ai_model || cfg.describe_model,
    };
  };
  return {
    connections,
    assignments: {
      describe: assignment(describe),
      'video-describe': assignment(video),
      'generated-search': {
        connection_ids: [connections[0]!.id],
        model: generatedModel || cfg.describe_model,
      },
      'semantic-search': {
        connection_ids: [connections[0]!.id],
        model: cfg.embedder_model,
      },
    },
  };
}

export function publicAiConnections(config: AiConnectionsConfig & { needs_save?: boolean }) {
  return {
    ...config,
    connections: config.connections.map(({ api_key, ...connection }) => ({
      ...connection,
      has_key: Boolean(api_key),
    })),
    available_workers: AI_WORKERS,
    needs_save: config.needs_save ?? false,
  };
}

function endpointError(raw: string): string | null {
  try {
    const url = new URL(raw);
    return !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
      ? 'Use an HTTP(S) endpoint without credentials, query or fragment.'
      : null;
  } catch {
    return 'Enter a valid endpoint URL.';
  }
}

/** Ollama needs an endpoint; an OpenAI connection's base URL is optional; others have none. */
function connectionUrlError(c: AiConnection): string | null {
  if (c.provider === 'ollama') return endpointError(c.url);
  return c.provider === 'openai' && c.url.trim() ? endpointError(c.url) : null;
}

function validConcurrency(n: number): boolean {
  return Number.isInteger(n) && n >= 1 && n <= 100;
}

function connectionError(c: AiConnection): string | null {
  if (!/^[\w-]+$/.test(c.id) || !c.name.trim()) return 'Connections need IDs and a name.';
  if (!['ollama', 'openai', 'anthropic', 'gemini'].includes(c.provider)) return 'Unknown provider.';
  if (!validConcurrency(c.concurrency)) return 'Connection concurrency must be between 1 and 100.';
  const urlError = connectionUrlError(c);
  if (urlError || c.provider === 'ollama') return urlError;
  return c.api_key?.trim() ? null : `${c.name} needs an API key.`;
}

function poolError(
  connections: AiConnection[],
  worker: (typeof AI_WORKERS)[number],
): string | null {
  if (connections.some((c) => !worker.providers.includes(c.provider)))
    return `${worker.name} supports only ${worker.providers.join(' or ')} connections.`;
  if (connections.length > 1 && !worker.multiple)
    return `${worker.name} supports only one connection.`;
  if (
    connections.length > 1 &&
    new Set(connections.filter((c) => c.provider === 'ollama').map((c) => new URL(c.url).href))
      .size !== connections.filter((c) => c.provider === 'ollama').length
  )
    return `${worker.name} has duplicate endpoints.`;
  if (connections.reduce((n, c) => n + c.concurrency, 0) > 100)
    return `${worker.name} total concurrency must not exceed 100.`;
  return null;
}

function assignmentError(
  config: AiConnectionsConfig,
  worker: (typeof AI_WORKERS)[number],
): string | null {
  const a = config.assignments[worker.id];
  if (
    !a ||
    !a.connection_ids.length ||
    a.connection_ids.some((id) => !assignmentModel(a, id).trim())
  )
    return `${worker.name} needs a connection and model.`;
  const selected = a.connection_ids.map((id) => config.connections.find((c) => c.id === id));
  if (selected.some((c) => !c) || new Set(a.connection_ids).size !== selected.length)
    return `${worker.name} has an invalid connection selection.`;
  return poolError(
    selected.filter((c): c is AiConnection => Boolean(c)),
    worker,
  );
}

export function validateAiConnections(config: AiConnectionsConfig): string | null {
  if (new Set(config.connections.map((c) => c.id)).size !== config.connections.length)
    return 'Connection IDs must be unique.';
  for (const connection of config.connections) {
    const error = connectionError(connection);
    if (error) return error;
  }
  if (Object.keys(config.assignments).some((id) => !AI_WORKERS.some((w) => w.id === id)))
    return 'Unknown worker assignment.';
  for (const worker of AI_WORKERS) {
    const error = assignmentError(config, worker);
    if (error) return error;
  }
  return null;
}

export function assignmentModel(a: AiAssignment, id: string): string {
  return a.connection_models ? (a.connection_models[id] ?? '') : a.model;
}

export function assignedAi(config: AiConnectionsConfig | undefined, worker: string) {
  const assignment = config?.assignments[worker];
  if (!config || !assignment) return null;
  const connections = assignment.connection_ids.map(
    (id) => config.connections.find((c) => c.id === id)!,
  );
  if (!connections.length || connections.some((c) => !c))
    throw new Error(`Invalid AI assignment for ${worker}`);
  return {
    ...assignment,
    model: assignmentModel(assignment, connections[0]!.id),
    connections,
    primary: connections[0]!,
  };
}
