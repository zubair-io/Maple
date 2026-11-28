import { child } from '../log.ts';
import type { BackupRepository } from './repository.ts';

const log = child('cloud-backup:connection');

/**
 * A Drive connection change fences in-flight transfers immediately (a
 * generation bump), while the per-entry invalidation and error clearing (one row-trigger pass over every
 * entry, seconds on a large library) run after the response instead of
 * holding the OAuth callback page. Work is serialized per destination so a
 * restore never clears errors before the invalidation it follows.
 */
export class ConnectionRefresh {
  private readonly queues = new Map<string, Promise<void>>();

  constructor(private readonly repo: BackupRepository) {}

  /** A different OAuth client: every entry is re-verified against it. */
  async changed(destinationId: string): Promise<void> {
    await this.fenced(destinationId);
    this.enqueue(destinationId, 'invalidate', () => this.repo.invalidateEntries(destinationId));
  }

  /** The same client and root: verified entries stay verified, in-flight transfers stop. */
  async fenced(destinationId: string): Promise<void> {
    await this.repo.db.write(`UPDATE backup_destinations SET generation=generation+1 WHERE id=?`, [
      destinationId,
    ]);
  }

  async restored(destinationId: string): Promise<void> {
    this.enqueue(destinationId, 'clear-connection-errors', () =>
      this.repo.clearResolvedConnectionErrors(destinationId),
    );
  }

  settled(destinationId: string): Promise<void> {
    return this.queues.get(destinationId) ?? Promise.resolve();
  }

  private enqueue(destinationId: string, step: string, work: () => Promise<void>): void {
    const next = this.settled(destinationId)
      .then(work)
      .catch((err: unknown) =>
        log.error({ destinationId, step, err }, 'Drive connection refresh failed'),
      );
    this.queues.set(destinationId, next);
    void next.then(() => {
      if (this.queues.get(destinationId) === next) this.queues.delete(destinationId);
    });
  }
}
