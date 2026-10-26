/**
 * The `embed` stage's document embedder (#5445), as the worker tier reaches it.
 *
 * The bundled bge-m3 lives in the API's search child, which already holds it for queries: a second
 * copy in the worker tier would double that memory, and `bun:ffi` would block the worker's event
 * loop for the whole batch. So the worker asks over the IPC channel the supervisor already holds
 * open (`runtime/worker-supervisor.ts`), the same way `remote-search.ts` ranks: a `search-embed`
 * request out, a `search-embed-reply` back. Vectors cross both hops as base64 f32 bytes.
 *
 * A missing channel, a child that is not running or still loading, and a reply that never comes
 * within {@link REMOTE_EMBED_TIMEOUT_MS} all answer `waiting`, so the stage tries again later
 * without spending a retry.
 */

import { vectorFromBase64, vectorToBase64 } from '../enrichment/vector-codec.ts';
import { EMBED_TIMEOUT_MS, localSearchChildPool } from './search-pool.ts';
import type { EmbedOutcome } from './search-protocol.ts';

/** The pool's own deadline for a batch, plus the wait behind a full queue and the two hops. */
const REMOTE_EMBED_TIMEOUT_MS = 5 * EMBED_TIMEOUT_MS;

/** More than the stage ever sends at once; a larger request is refused, not run. */
export const MAX_REMOTE_EMBED_TEXTS = 64;

type WireOutcome = { ok: true; vectors: string[] } | { ok: false; waiting: boolean; error: string };

interface SearchEmbedRequest {
  type: 'search-embed';
  id: number;
  texts: string[];
}

interface SearchEmbedReply {
  type: 'search-embed-reply';
  id: number;
  outcome: WireOutcome;
}

const waitingFor = (error: string): EmbedOutcome => ({ ok: false, waiting: true, error });

function isRequest(message: unknown): message is SearchEmbedRequest {
  const m = message as Partial<SearchEmbedRequest> | null;
  return (
    m?.type === 'search-embed' &&
    typeof m.id === 'number' &&
    Array.isArray(m.texts) &&
    m.texts.every((text) => typeof text === 'string')
  );
}

function isReply(message: unknown): message is SearchEmbedReply {
  const m = message as Partial<SearchEmbedReply> | null;
  return m?.type === 'search-embed-reply' && typeof m.id === 'number' && Boolean(m.outcome);
}

function fromWire(outcome: WireOutcome): EmbedOutcome {
  return outcome.ok ? { ok: true, vectors: outcome.vectors.map(vectorFromBase64) } : outcome;
}

function toWire(outcome: EmbedOutcome): WireOutcome {
  return outcome.ok ? { ok: true, vectors: outcome.vectors.map(vectorToBase64) } : outcome;
}

export interface RemoteDocumentEmbedder {
  embed(texts: readonly string[]): Promise<EmbedOutcome>;
  /** Hands a message from the API process to the waiting request, if it is a reply. */
  receive(message: unknown): void;
}

/** The worker's side: requests go out through `send`, replies come back through `receive`. */
export function remoteDocumentEmbedder(
  send: (message: SearchEmbedRequest) => void,
  timeoutMs: number = REMOTE_EMBED_TIMEOUT_MS,
): RemoteDocumentEmbedder {
  const waiting = new Map<number, (outcome: EmbedOutcome) => void>();
  const sequence = { next: 1 };
  return {
    async embed(texts) {
      const id = sequence.next++;
      const reply = new Promise<EmbedOutcome>((resolve) => waiting.set(id, resolve));
      const clock: { timer?: ReturnType<typeof setTimeout> } = {};
      const expiry = new Promise<EmbedOutcome>((resolve) => {
        clock.timer = setTimeout(
          () => resolve(waitingFor(`the search engine did not answer within ${timeoutMs} ms`)),
          timeoutMs,
        );
        clock.timer.unref?.();
      });
      try {
        send({ type: 'search-embed', id, texts: [...texts] });
        return await Promise.race([reply, expiry]);
      } catch (err) {
        return waitingFor(err instanceof Error ? err.message : String(err));
      } finally {
        clearTimeout(clock.timer);
        waiting.delete(id);
      }
    },
    receive(message) {
      if (isReply(message)) waiting.get(message.id)?.(fromWire(message.outcome));
    },
  };
}

/** Worker boot: the stage's embedder when this process has a channel to the API, else null. */
export function installRemoteDocumentEmbedder(): RemoteDocumentEmbedder | null {
  const send = process.send?.bind(process);
  if (!send) return null;
  const remote = remoteDocumentEmbedder((message) => send(message));
  process.on('message', (message: unknown) => remote.receive(message));
  return remote;
}

/**
 * The API's side: answer a worker's `search-embed` request from this process's child. Returns
 * whether the message was one, so the supervisor can ignore everything else.
 */
export function answerRemoteEmbed(
  worker: { postMessage(message: SearchEmbedReply): void },
  message: unknown,
  engine: {
    embed(texts: readonly string[]): Promise<EmbedOutcome>;
  } | null = localSearchChildPool(),
): boolean {
  if (!isRequest(message)) return false;
  const reply = (outcome: EmbedOutcome): void => {
    try {
      worker.postMessage({ type: 'search-embed-reply', id: message.id, outcome: toWire(outcome) });
    } catch {
      // The worker died between asking and the answer; its respawn asks again.
    }
  };
  if (message.texts.length > MAX_REMOTE_EMBED_TEXTS) {
    reply({
      ok: false,
      waiting: false,
      error: `at most ${MAX_REMOTE_EMBED_TEXTS} texts a request`,
    });
    return true;
  }
  const embedding = engine?.embed(message.texts);
  if (!embedding) {
    reply(waitingFor('the API is not running a search engine'));
    return true;
  }
  void embedding.then(reply, (err: unknown) =>
    reply(waitingFor(err instanceof Error ? err.message : String(err))),
  );
  return true;
}
