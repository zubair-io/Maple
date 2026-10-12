/**
 * The in-process engine as the worker tier sees it (#4510).
 *
 * The search child belongs to the API process: it holds the model and every vector, and a second
 * copy in the worker tier would double that memory. The worker still has to rank For You themes
 * the way the API will render them, so it asks the API's child over the IPC channel the
 * supervisor already holds open (`runtime/worker-supervisor.ts`): a `search-rank` request out, a
 * `search-rank-reply` back.
 *
 * Every failure is `null`, exactly as the local pool answers: no channel, the API's child not
 * running or still loading, a reply that never comes within {@link REMOTE_TIMEOUT_MS}. The caller
 * then ranks in the database, through the same bounded window.
 */

import {
  QUERY_TIMEOUT_MS,
  inProcessSearch,
  setRemoteInProcessSearch,
  type InProcessRanker,
} from './search-pool.ts';
import type { FusedSearchHit } from './search-engine-ffi.ts';
import { RANKED_WINDOW_MAX } from '../db/repos/search.ranked.ts';
import { MAX_TEXT_QUERY_LENGTH } from '../db/repos/search.where.ts';
import { child as childLogger } from '../log.ts';

const log = childLogger('remote-search');

/** The API pool's own deadline plus a second for the two IPC hops. */
const REMOTE_TIMEOUT_MS = QUERY_TIMEOUT_MS + 1_000;

interface SearchRankRequest {
  type: 'search-rank';
  id: number;
  query: string;
  k: number;
}

interface SearchRankReply {
  type: 'search-rank-reply';
  id: number;
  hits: FusedSearchHit[] | null;
}

function isRequest(message: unknown): message is SearchRankRequest {
  const m = message as Partial<SearchRankRequest> | null;
  return (
    m?.type === 'search-rank' &&
    typeof m.id === 'number' &&
    typeof m.query === 'string' &&
    typeof m.k === 'number'
  );
}

function isReply(message: unknown): message is SearchRankReply {
  const m = message as Partial<SearchRankReply> | null;
  return m?.type === 'search-rank-reply' && typeof m.id === 'number';
}

export interface RemoteInProcessSearch extends InProcessRanker {
  /** Hands a message from the API process to the waiting request, if it is a reply. */
  receive(message: unknown): void;
}

/** The worker's side: requests go out through `send`, replies come back through `receive`. */
export function remoteInProcessSearch(
  send: (message: SearchRankRequest) => void,
  timeoutMs: number = REMOTE_TIMEOUT_MS,
): RemoteInProcessSearch {
  const waiting = new Map<number, (hits: FusedSearchHit[] | null) => void>();
  const sequence = { next: 1 };
  return {
    async search(query, k) {
      const id = sequence.next++;
      const reply = new Promise<FusedSearchHit[] | null>((resolve) => waiting.set(id, resolve));
      const clock: { timer?: ReturnType<typeof setTimeout> } = {};
      const expiry = new Promise<null>((resolve) => {
        clock.timer = setTimeout(() => resolve(null), timeoutMs);
        clock.timer.unref?.();
      });
      try {
        send({ type: 'search-rank', id, query, k });
        return await Promise.race([reply, expiry]);
      } catch {
        return null;
      } finally {
        clearTimeout(clock.timer);
        waiting.delete(id);
      }
    },
    receive(message) {
      if (isReply(message)) waiting.get(message.id)?.(message.hits ?? null);
    },
  };
}

/** Worker boot: rank through the API's child when this process has a channel to it. */
export function installRemoteInProcessSearch(): void {
  const send = process.send?.bind(process);
  if (!send) return;
  const remote = remoteInProcessSearch((message) => send(message));
  process.on('message', (message: unknown) => remote.receive(message));
  setRemoteInProcessSearch(remote);
}

/**
 * The API's side: answer a worker's `search-rank` request from this process's child. Returns
 * whether the message was one, so the supervisor can ignore everything else. The depth is clamped
 * to a window's cap and a query longer than a search accepts is answered null without reaching
 * the child, whatever the worker sent.
 */
export function answerRemoteSearch(
  worker: { postMessage(message: SearchRankReply): void },
  message: unknown,
  engine: InProcessRanker | null = inProcessSearch(),
): boolean {
  if (!isRequest(message)) return false;
  const k = Math.min(Math.max(1, Math.floor(message.k)), RANKED_WINDOW_MAX);
  const reply = (hits: FusedSearchHit[] | null): void => {
    try {
      worker.postMessage({ type: 'search-rank-reply', id: message.id, hits });
    } catch {
      // The worker died between asking and the answer; its respawn asks again.
    }
  };
  const search =
    message.query.length > MAX_TEXT_QUERY_LENGTH
      ? null
      : (engine?.search(message.query, k) ?? null);
  void (search ?? Promise.resolve(null)).then(reply, (err: unknown) => {
    log.warn({ err: err instanceof Error ? err.message : String(err) }, 'remote search failed');
    reply(null);
  });
  return true;
}
