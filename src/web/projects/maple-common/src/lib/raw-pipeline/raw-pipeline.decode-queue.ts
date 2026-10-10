/** Serialize worker calls that compete for the WASM heap. */
export class RawPipelineDecodeQueue {
  private tail: Promise<unknown> = Promise.resolve();

  enqueue<T>(run: () => Promise<T>): Promise<T> {
    const next = this.tail.then(run, run);
    this.tail = next.catch(() => undefined);
    return next;
  }
}
