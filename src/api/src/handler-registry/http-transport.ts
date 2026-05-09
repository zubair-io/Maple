/**
 * HTTP transport for external stage handlers.
 *
 * POSTs the contract input as JSON to the configured URL and parses the
 * response as a contract output. Behaviour:
 *
 *   - Default timeout 30 s (override per-row via `timeout_ms`).
 *   - 5xx responses are retried once after a short delay.
 *   - 4xx responses are NOT retried — they indicate a contract bug.
 *   - Network/timeout errors propagate; the pipeline's outer `withRetry`
 *     decides whether to retry the stage.
 *
 * No auth headers in v1. Adding them is trivial: extend `StageHandlerDoc`
 * with an `auth_header` field and forward it in `init.headers` below.
 */

import type { AiHandlerInput, AiHandlerOutput } from "./contract.ts";
import { parseAiOutput } from "./contract.ts";

export const DEFAULT_TIMEOUT_MS = 30_000;
const RETRY_DELAY_MS = 200;

/**
 * Minimal fetch shape used by the transport. Accepts the global `fetch`
 * directly; tests can pass a stub matching this signature without having to
 * mirror the runtime's full type (which differs between Bun and Node).
 */
export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal }
) => Promise<Response>;

export interface HttpTransportOptions {
  url: string;
  timeoutMs?: number;
  /** Injectable for tests. Defaults to global fetch. */
  fetchImpl?: FetchLike;
}

/**
 * Dispatch one `ai`-stage call over HTTP. Returns the parsed contract output.
 * Throws on non-success status, schema mismatch, or transport timeout.
 */
export async function dispatchAi(
  input: AiHandlerInput,
  opts: HttpTransportOptions
): Promise<AiHandlerOutput> {
  const f: FetchLike = opts.fetchImpl ?? ((url, init) => fetch(url, init));
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const attempt = async (): Promise<Response> => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      return await f(opts.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
        signal: ctrl.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  };

  let res: Response;
  try {
    res = await attempt();
  } catch (e) {
    // Transport error (timeout, DNS, ECONNREFUSED). Surface to caller; the
    // pipeline's withRetry will retry per its policy.
    throw new Error(
      `[handler-registry:http] transport error: ${e instanceof Error ? e.message : String(e)}`
    );
  }

  // Single retry for 5xx — distinguish transient backend errors from
  // contract bugs (4xx). 4xx surfaces immediately so the stage can dead-letter
  // fast instead of waiting on three retries × backoff.
  if (res.status >= 500 && res.status < 600) {
    await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
    try {
      res = await attempt();
    } catch (e) {
      throw new Error(
        `[handler-registry:http] retry transport error: ${e instanceof Error ? e.message : String(e)}`
      );
    }
  }

  if (!res.ok) {
    throw new Error(
      `[handler-registry:http] handler returned HTTP ${res.status} ${res.statusText}`
    );
  }

  let body: unknown;
  try {
    body = await res.json();
  } catch (e) {
    throw new Error(
      `[handler-registry:http] response is not valid JSON: ${e instanceof Error ? e.message : String(e)}`
    );
  }
  return parseAiOutput(body);
}
