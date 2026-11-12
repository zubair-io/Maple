import type { ImportedWbSession } from './raw-pipeline.imported-wb.types';

/** One immutable editor source per worker. decodeChain fences reuse behind
 * the open reply; its existing failure path clears this state before retry. */
export class CpuSourceTransfer {
  private source?: { bytes: Uint8Array; ext: string; worker: Worker; token: number };
  private live?: { bytes: Uint8Array; worker: Worker; token: number };
  private readonly empty = new ArrayBuffer(0);
  private readonly noTransfer: Transferable[] = [];
  buffer: ArrayBuffer = this.empty;
  transferred: Transferable[] = this.noTransfer;
  token?: number;
  epoch = 0;

  prepare(bytes: Uint8Array, ext: string, worker: Worker, id: number, sized: boolean): void {
    const reused = sized && this.holds(bytes, ext, worker);
    this.token = sized ? (reused ? this.source!.token : id) : undefined;
    this.buffer = reused
      ? this.empty
      : (bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
    this.transferred = reused ? this.noTransfer : [this.buffer];
    if (!reused) this.source = sized ? { bytes, ext, worker, token: id } : undefined;
  }
  private holds(bytes: Uint8Array, ext: string, worker: Worker): boolean {
    const source = this.source;
    return source?.bytes === bytes && source.ext === ext && source.worker === worker;
  }
  clear(): void {
    this.source = undefined;
  }
  /** A GPU open overtakes the decode queue: decodes queued before it must not
   * re-establish a retained source the GPU session would then sit beside. The
   * open's request id names that live session. */
  retire(bytes: Uint8Array, worker: Worker, openId: number): void {
    this.source = undefined;
    this.live = { bytes, worker, token: openId };
    this.epoch += 1;
  }
  /** The worker session currently holding `bytes`, or null (#4669). A retained
   * source is newer than any GPU open (`retire` drops it), e.g. the 2D fallback
   * after a failed open. The worker re-checks the token, so a replacement still
   * in flight rejects rather than estimating another photo. */
  sessionFor(bytes: Uint8Array, worker: Worker): ImportedWbSession | null {
    const source = this.source;
    if (source?.bytes === bytes && source.worker === worker)
      return { kind: 'cpu', token: source.token };
    const live = this.live;
    if (live?.bytes === bytes && live.worker === worker) return { kind: 'live', token: live.token };
    return null;
  }
}
