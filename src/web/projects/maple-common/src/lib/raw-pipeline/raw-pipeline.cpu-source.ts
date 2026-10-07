/** One immutable editor source per worker. decodeChain fences reuse behind
 * the open reply; its existing failure path clears this state before retry. */
export class CpuSourceTransfer {
  private source?: { bytes: Uint8Array; ext: string; worker: Worker; token: number };
  private readonly empty = new ArrayBuffer(0);
  private readonly noTransfer: Transferable[] = [];
  buffer: ArrayBuffer = this.empty;
  transferred: Transferable[] = this.noTransfer;
  token?: number;
  epoch = 0;

  prepare(bytes: Uint8Array, ext: string, worker: Worker, id: number, sized: boolean): void {
    const reused =
      sized &&
      this.source?.bytes === bytes &&
      this.source.ext === ext &&
      this.source.worker === worker;
    this.token = sized ? (reused ? this.source!.token : id) : undefined;
    this.buffer = reused
      ? this.empty
      : (bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
    this.transferred = reused ? this.noTransfer : [this.buffer];
    if (!reused) this.source = sized ? { bytes, ext, worker, token: id } : undefined;
  }
  clear(): void {
    this.source = undefined;
  }
  /** A GPU open overtakes the decode queue: decodes queued before it must not
   * re-establish a retained source the GPU session would then sit beside. */
  retire(): void {
    this.source = undefined;
    this.epoch += 1;
  }
}
