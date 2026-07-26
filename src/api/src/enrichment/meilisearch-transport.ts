export interface MeilisearchTransportConfig {
  url: string | undefined;
  apiKey: string | undefined;
  fetchImpl: typeof fetch;
  taskPollIntervalMs: number;
  taskTimeoutMs: number;
}

/** Bulk embedding can be CPU-bound; allow ten minutes before retrying the
 * same durable batch. Operators can tune this from Settings → Workers. */
export const DEFAULT_MEILISEARCH_TASK_TIMEOUT_MS = 10 * 60 * 1000;

export interface MeilisearchHttpResult<T> {
  ok: boolean;
  status: number;
  body: T | null;
  errorText: string | null;
}

export interface MeilisearchTaskSummary {
  taskUid?: number;
}

interface MeilisearchTask {
  uid: number;
  status: 'enqueued' | 'processing' | 'succeeded' | 'failed' | 'canceled';
  error?: unknown;
}

export function isLiveConfig<T extends MeilisearchTransportConfig>(
  config: T,
): config is T & { url: string } {
  return typeof config.url === 'string' && config.url.length > 0;
}

export function joinMeilisearchUrl(base: string, path: string): string {
  const normalizedBase = base.replace(/\/+$/, '');
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  return normalizedBase + normalizedPath;
}

export async function meilisearchHttp<T>(
  config: MeilisearchTransportConfig,
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
  path: string,
  body?: unknown,
): Promise<MeilisearchHttpResult<T>> {
  if (!isLiveConfig(config)) {
    return { ok: true, status: 200, body: null, errorText: null };
  }
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (config.apiKey) headers.Authorization = `Bearer ${config.apiKey}`;
  let response: Response;
  try {
    response = await config.fetchImpl(joinMeilisearchUrl(config.url, path), {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (error) {
    return {
      ok: false,
      status: 0,
      body: null,
      errorText: error instanceof Error ? error.message : String(error),
    };
  }

  const text = await response.text().catch(() => '');
  let parsed: unknown = null;
  if (text.length > 0) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
  }
  if (!response.ok) {
    return {
      ok: false,
      status: response.status,
      body: null,
      errorText: typeof parsed === 'string' ? parsed : JSON.stringify(parsed),
    };
  }
  return { ok: true, status: response.status, body: parsed as T, errorText: null };
}

function taskFailure(task: MeilisearchTask): string {
  const detail = task.error === undefined ? '' : ` ${JSON.stringify(task.error)}`;
  return `meilisearch task ${task.uid} ${task.status}${detail}`;
}

function acceptedTaskUid(
  accepted: MeilisearchHttpResult<MeilisearchTaskSummary>,
  operation: string,
): number {
  if (!accepted.ok) {
    throw new Error(
      `meilisearch ${operation} failed: status=${accepted.status} ${accepted.errorText ?? ''}`,
    );
  }
  const uid = accepted.body?.taskUid;
  if (!Number.isInteger(uid) || uid! < 0) {
    throw new Error(`meilisearch ${operation} response did not include taskUid`);
  }
  return uid!;
}

async function readTask(
  config: MeilisearchTransportConfig,
  taskUid: number,
  operation: string,
): Promise<MeilisearchTask> {
  const result = await meilisearchHttp<MeilisearchTask>(config, 'GET', `/tasks/${taskUid}`);
  if (result.ok && result.body) return result.body;
  throw new Error(
    `meilisearch ${operation} task poll failed: status=${result.status} ${result.errorText ?? ''}`,
  );
}

function taskFinished(task: MeilisearchTask): boolean {
  if (task.status === 'succeeded') return true;
  if (task.status === 'failed' || task.status === 'canceled') {
    throw new Error(taskFailure(task));
  }
  return false;
}

async function pause(ms: number): Promise<void> {
  if (ms > 0) await new Promise((resolve) => setTimeout(resolve, ms));
}

export async function waitForMeilisearchTask(
  config: MeilisearchTransportConfig,
  accepted: MeilisearchHttpResult<MeilisearchTaskSummary>,
  operation: string,
): Promise<void> {
  const taskUid = acceptedTaskUid(accepted, operation);
  const deadline = Date.now() + config.taskTimeoutMs;
  while (Date.now() <= deadline) {
    if (taskFinished(await readTask(config, taskUid, operation))) return;
    await pause(config.taskPollIntervalMs);
  }
  throw new Error(`meilisearch ${operation} task ${taskUid} timed out`);
}
