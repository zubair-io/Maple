/**
 * Byte-denominated admission for native decodes and panorama stitches (#5467).
 *
 * A worker count bounds how many decodes run, not how much memory they take:
 * a 50 MP CR2 extraction peaks near 0.5 GB while developing the same file with
 * its sidecar peaks at 4–7 GB, so sixteen develops at once asked for ~100 GB
 * of a 44 GB container and the kernel killed decode children. Each RAW-lane
 * request therefore reserves its estimated peak here before it reaches a
 * child, and releases it when the child answers or dies. Work that does not
 * fit waits in FIFO order, so a large request is never starved by a stream of
 * small ones. A panorama stitch reserves the whole budget, so it never runs
 * beside a decode.
 *
 * Each process that owns a decode pool meters its own: the worker tier, where
 * the stages and the job runner run, and the request-serving process, which
 * renders on demand (#6101). The configured percentage is split between them.
 * A null limit disables the cap entirely (the operator escape hatch: percent 0
 * on Settings → Workers): decodes then bypass admission altogether.
 */

import { stat } from '../fs/mirrored.ts';

const MIB = 1024 * 1024;
const GIB = 1024 * MIB;

/** `extract` pulls the embedded JPEG; `develop` demosaics the sensor data. */
export type DecodeWeight = 'extract' | 'develop';

export interface DecodeCost {
  weight: DecodeWeight;
  sourcePath: string;
}

/**
 * Peak RSS per source byte, measured 2026-10-28 on nine RAW fixtures (34–129 MB,
 * CR2/NEF/ARW/RAF/DNG/100 MP DNG) in a fresh process: extraction peaked at
 * 0.26–0.50 GB (at most 14× the file), develop at 3.5–12 GB (69–124× the file),
 * a sidecar recipe render at 2.7–3.8 GB. Compressed RAW stores ~1–2 bytes per
 * photosite, so the file size tracks the pixel count the decoder allocates for.
 */
const EXTRACT_BYTES_PER_SOURCE_BYTE = 12;
const EXTRACT_FLOOR_BYTES = 512 * MIB;
const DEVELOP_BYTES_PER_SOURCE_BYTE = 128;
const DEVELOP_FLOOR_BYTES = 1 * GIB;

export function estimateDecodePeakBytes(weight: DecodeWeight, sourceBytes: number): number {
  return weight === 'extract'
    ? Math.max(EXTRACT_FLOOR_BYTES, sourceBytes * EXTRACT_BYTES_PER_SOURCE_BYTE)
    : Math.max(DEVELOP_FLOOR_BYTES, sourceBytes * DEVELOP_BYTES_PER_SOURCE_BYTE);
}

/** An unreadable source costs the floor; the decode itself reports why. */
export async function estimateDecodeCost(cost: DecodeCost): Promise<number> {
  const sourceBytes = await stat(cost.sourcePath).then(
    (s) => s.size,
    () => 0,
  );
  return estimateDecodePeakBytes(cost.weight, sourceBytes);
}

/** The request-serving process and the worker tier hold separate budgets out of one configured
 * percentage; on-demand renders are mostly small extractions while the background stages carry
 * the bulk of the develops, so the request process takes the smaller share. */
export const REQUEST_PROCESS_BUDGET_SHARE = 0.25;
export const WORKER_TIER_BUDGET_SHARE = 1 - REQUEST_PROCESS_BUDGET_SHARE;

/** The budget for a percent of the container limit; 0 means no cap. */
export function budgetBytesForPercent(
  percent: number,
  containerLimitBytes: number,
  share = 1,
): number | null {
  return percent <= 0 ? null : Math.floor(((containerLimitBytes * percent) / 100) * share);
}

function gib(bytes: number): string {
  return `${(bytes / GIB).toFixed(1)} GiB`;
}

/** One decode needs more than the whole budget. Says nothing about the file. */
export class DecodeMemoryBudgetError extends Error {
  override readonly name = 'DecodeMemoryBudgetError';
  constructor(
    readonly requestedBytes: number,
    readonly limitBytes: number,
  ) {
    super(
      `decode needs an estimated ${gib(requestedBytes)} but the decode memory budget is ` +
        `${gib(limitBytes)}; raise "Decode memory budget" on Settings → Workers, or set it to 0 to remove the cap`,
    );
  }
}

export type ReleaseReservation = () => void;

export interface DecodeBudgetSnapshot {
  limitBytes: number | null;
  reservedBytes: number;
  running: number;
  waiting: number;
}

interface Waiter {
  /** Read at admission: a whole-budget waiter takes whatever the limit is then. */
  bytes: () => number;
  whole: boolean;
  resolve: (release: ReleaseReservation) => void;
  reject: (error: Error) => void;
}

export class DecodeMemoryBudget {
  private limitBytes: number | null = null;
  private oversizeRunsAlone = false;
  private reservedBytes = 0;
  private running = 0;
  /** Whole-budget holders. Tracked apart from bytes: raising the limit while a
   * stitch runs must not admit decodes beside it. */
  private exclusive = 0;
  private readonly waiters: Waiter[] = [];

  capped(): boolean {
    return this.limitBytes !== null;
  }

  /** `oversizeRunsAlone`: a decode estimated above the limit waits for an idle budget and then
   * runs by itself, instead of being rejected. The request process sets it so a RAW that develops
   * today still renders on demand under its smaller share. */
  configure(limitBytes: number | null, options?: { oversizeRunsAlone?: boolean }): void {
    this.limitBytes = limitBytes;
    this.oversizeRunsAlone = options?.oversizeRunsAlone ?? false;
    this.pump();
  }

  acquire(bytes: number): Promise<ReleaseReservation> {
    return this.enqueue(() => bytes, false);
  }

  /** Reserve the entire budget: waits for every running decode to finish. */
  acquireAll(): Promise<ReleaseReservation> {
    return this.enqueue(() => this.limitBytes ?? 0, true);
  }

  /** Shutdown: nothing will ever release for these. */
  rejectWaiters(error: Error): void {
    for (const waiter of this.waiters.splice(0)) waiter.reject(error);
  }

  snapshot(): DecodeBudgetSnapshot {
    return {
      limitBytes: this.limitBytes,
      reservedBytes: this.reservedBytes,
      running: this.running,
      waiting: this.waiters.length,
    };
  }

  private enqueue(bytes: () => number, whole: boolean): Promise<ReleaseReservation> {
    const { promise, resolve, reject } = Promise.withResolvers<ReleaseReservation>();
    this.waiters.push({ bytes, whole, resolve, reject });
    this.pump();
    return promise;
  }

  private oversize(waiter: Waiter, bytes: number): DecodeMemoryBudgetError | null {
    return !waiter.whole &&
      !this.oversizeRunsAlone &&
      this.limitBytes !== null &&
      bytes > this.limitBytes
      ? new DecodeMemoryBudgetError(bytes, this.limitBytes)
      : null;
  }

  private fits(bytes: number): boolean {
    if (this.limitBytes === null) return true;
    if (this.exclusive > 0) return false;
    return bytes > this.limitBytes
      ? this.running === 0
      : this.reservedBytes + bytes <= this.limitBytes;
  }

  private pump(): void {
    while (this.waiters.length > 0) {
      const head = this.waiters[0]!;
      const bytes = head.bytes();
      const tooLarge = this.oversize(head, bytes);
      if (!tooLarge && !this.fits(bytes)) return;
      this.waiters.shift();
      if (tooLarge) head.reject(tooLarge);
      else head.resolve(this.grant(bytes, head.whole));
    }
  }

  private grant(bytes: number, whole: boolean): ReleaseReservation {
    this.reservedBytes += bytes;
    this.running++;
    if (whole) this.exclusive++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.reservedBytes -= bytes;
      this.running--;
      if (whole) this.exclusive--;
      this.pump();
    };
  }
}

let processBudget: DecodeMemoryBudget | null = null;

/** This process's budget. Unconfigured (no cap) until the process applies the setting at boot. */
export function decodeMemoryBudget(): DecodeMemoryBudget {
  processBudget ??= new DecodeMemoryBudget();
  return processBudget;
}
