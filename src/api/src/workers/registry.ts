/**
 * In-process stage registry — the small object that replaces the deleted
 * multi-process `Supervisor` (issue #135).
 *
 * Each `runStage()` call publishes its name plus a handful of accessors
 * (in-flight count, throughput, paused flag, control callbacks) here. The
 * worker-management HTTP routes (`workers/routes.ts`) and the `/api/events`
 * WS bridge (`routes/events.ts`) both read live state through this registry
 * instead of polling a child process over IPC.
 *
 * Lifecycle: `runStage()` calls `register()` after bootConfig succeeds, and
 * `unregister()` once `stop()` finishes draining. The registry is a process-
 * level singleton — there is only one API server.
 */

export type StageStatus =
  | "running"
  | "paused"
  | "stopped"
  | "error";

export interface StageRegistryEntry {
  /** Static — comes from the StageConfig. */
  targetVersion: number;
  /** Live accessors — read on every /status call. */
  getInFlight: () => number;
  getThroughput: () => number;
  getPaused: () => boolean;
  /** Re-read worker_config from Mongo and apply to the live config. */
  reloadConfig: () => Promise<void>;
  pause: () => Promise<void>;
  resume: () => Promise<void>;
}

/**
 * Snapshot shape returned by `statuses()`. Mirrors what the old supervisor
 * exposed (minus pid / restartCount / IPC-port plumbing that the in-process
 * world doesn't need) so callers in routes.ts and events.ts barely change.
 */
export interface StageStatusSnapshot {
  status: StageStatus;
  inFlight: number;
  throughput: number;
  targetVersion: number;
  lastError: string | null;
}

class StageRegistry {
  private readonly entries = new Map<string, StageRegistryEntry>();
  private readonly lastErrors = new Map<string, string>();
  /**
   * Stages the orchestrator expects to start. Populated by `preregister()`
   * at boot, before any stage's `runStage()` is invoked. `statuses()`
   * unions this with `entries` so a stage whose `bootConfig()` is still
   * retrying (or has permanently failed) surfaces as a "stopped" / "error"
   * row instead of being absent from `GET /api/workers/status` and the
   * WS bridge. Matches the old multi-process supervisor's behaviour where
   * `addStage()` registered every stage immediately with `status: "stopped"`.
   */
  private readonly known = new Map<string, { targetVersion: number }>();

  /**
   * Declare a stage the orchestrator plans to start so `statuses()` reports
   * it even before its first successful `runStage()`. Safe to call multiple
   * times — updates `targetVersion` and leaves any existing live entry /
   * recorded error untouched.
   */
  preregister(name: string, targetVersion: number): void {
    this.known.set(name, { targetVersion });
  }

  register(name: string, entry: StageRegistryEntry): void {
    this.entries.set(name, entry);
    this.lastErrors.delete(name);
  }

  unregister(name: string): void {
    this.entries.delete(name);
  }

  /** Record an error visible via `statuses()[name].lastError`. */
  recordError(name: string, message: string): void {
    this.lastErrors.set(name, message);
  }

  /** Clear a previously-recorded error after the stage recovers. */
  clearError(name: string): void {
    this.lastErrors.delete(name);
  }

  has(name: string): boolean {
    return this.entries.has(name);
  }

  names(): string[] {
    return [...this.entries.keys()];
  }

  statuses(): Record<string, StageStatusSnapshot> {
    const out: Record<string, StageStatusSnapshot> = {};
    // First emit any pre-registered stage whose live entry hasn't arrived
    // yet — these are stages the orchestrator declared at boot but whose
    // `runStage()` either hasn't completed or failed and is mid-retry.
    for (const [name, { targetVersion }] of this.known) {
      if (this.entries.has(name)) continue;
      const lastError = this.lastErrors.get(name) ?? null;
      out[name] = {
        status: lastError !== null ? "error" : "stopped",
        inFlight: 0,
        throughput: 0,
        targetVersion,
        lastError,
      };
    }
    for (const [name, entry] of this.entries) {
      out[name] = {
        status: entry.getPaused() ? "paused" : "running",
        inFlight: entry.getInFlight(),
        throughput: entry.getThroughput(),
        targetVersion: entry.targetVersion,
        lastError: this.lastErrors.get(name) ?? null,
      };
    }
    return out;
  }

  async pause(name: string): Promise<{ ok: boolean; error?: string }> {
    const entry = this.entries.get(name);
    if (!entry) return { ok: false, error: `unknown stage: ${name}` };
    try {
      await entry.pause();
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async resume(name: string): Promise<{ ok: boolean; error?: string }> {
    const entry = this.entries.get(name);
    if (!entry) return { ok: false, error: `unknown stage: ${name}` };
    try {
      await entry.resume();
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /**
   * Test-only: wipe all state. The registry is a process-level singleton,
   * so unit tests that exercise its mutators need a way to start clean
   * between cases. Production code never calls this.
   */
  _resetForTests(): void {
    this.entries.clear();
    this.lastErrors.clear();
    this.known.clear();
  }

  async notifyConfigChanged(name: string): Promise<{ ok: boolean; error?: string }> {
    const entry = this.entries.get(name);
    if (!entry) return { ok: false, error: `unknown stage: ${name}` };
    try {
      await entry.reloadConfig();
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
}

export const stageRegistry = new StageRegistry();
export type { StageRegistry };
