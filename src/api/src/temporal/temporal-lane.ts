import type { Client } from '@temporalio/client';

/** One task queue the host serves: what runs on it, and how work reaches it. */
export interface TemporalLane {
  taskQueue: string;
  activities: object;
  /** How many of its activities run at once. */
  concurrency: number;
  /** Hands waiting work to Temporal. Runs every relay tick while the server answers. */
  relay: (client: Client) => Promise<void>;
  /** Repairs what Temporal and the database disagree on. Runs with every connection check. */
  reconcile?: (client: Client) => Promise<void>;
}
