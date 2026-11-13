/**
 * The worker tier's side of a request to the API's search child over the supervisor's IPC channel
 * (`remote-search.ts`, `remote-embed.ts`): each request gets an id, and the reply carrying that id
 * settles it.
 */

export interface PendingReplies<T> {
  /**
   * Sends one request and waits for its reply. A send that throws or a reply that does not come
   * within `timeoutMs` answers `fallback(reason)` instead.
   */
  request(
    send: (id: number) => void,
    timeoutMs: number,
    fallback: (reason: string) => T,
  ): Promise<T>;
  /** Settles the request with this id, if it is still waiting. */
  settle(id: number, value: T): void;
}

export function pendingReplies<T>(): PendingReplies<T> {
  const waiting = new Map<number, (value: T) => void>();
  const sequence = { next: 1 };
  return {
    async request(send, timeoutMs, fallback) {
      const id = sequence.next++;
      const reply = new Promise<T>((resolve) => waiting.set(id, resolve));
      const clock: { timer?: ReturnType<typeof setTimeout> } = {};
      const expiry = new Promise<T>((resolve) => {
        clock.timer = setTimeout(
          () => resolve(fallback(`no reply within ${timeoutMs} ms`)),
          timeoutMs,
        );
        clock.timer.unref?.();
      });
      try {
        send(id);
        return await Promise.race([reply, expiry]);
      } catch (err) {
        return fallback(err instanceof Error ? err.message : String(err));
      } finally {
        clearTimeout(clock.timer);
        waiting.delete(id);
      }
    },
    settle(id, value) {
      waiting.get(id)?.(value);
    },
  };
}
