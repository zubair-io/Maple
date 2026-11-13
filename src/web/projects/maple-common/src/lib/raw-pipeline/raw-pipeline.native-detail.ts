import { NativeDetailSupersededError } from './raw-pipeline.native-detail.types';
import type { PendingHandler } from './raw-pipeline.service-internals';
import type {
  NativeDetailArgs,
  NativeDetailPixels,
  NativeDetailRequest,
} from './raw-pipeline.native-detail.types';

/** One worker-side decoded mosaic. RAW bytes cross only on the first patch. */
export class NativeDetailClient {
  private sourceId: string | null = null;
  private records?: string;
  private epoch = 0;
  private usedWorker: Worker | null = null;
  constructor(
    private readonly worker: () => Worker,
    private readonly nextId: () => number,
    private readonly pending: Map<number, PendingHandler>,
  ) {}

  revision(): number {
    return this.epoch;
  }

  async render(args: NativeDetailArgs, epoch: number): Promise<NativeDetailPixels> {
    if (epoch !== this.epoch) return Promise.reject(new NativeDetailSupersededError());
    const { removalRecords, loadRemovals, ...input } = args;
    const bundle =
      removalRecords && (this.sourceId !== args.sourceId || this.records !== removalRecords)
        ? await loadRemovals?.()
        : undefined;
    if (epoch !== this.epoch) throw new NativeDetailSupersededError();
    if (
      removalRecords &&
      (this.sourceId !== args.sourceId || this.records !== removalRecords) &&
      !bundle
    )
      throw new Error('Saved native detail requires verified removal companions');
    const worker = this.worker();
    this.usedWorker = worker;
    const id = this.nextId();
    const bytes =
      this.sourceId === args.sourceId ? undefined : (args.bytes.slice().buffer as ArrayBuffer);
    const removals = bundle
      ? { manifest: bundle.manifest, companions: bundle.bytes.slice().buffer as ArrayBuffer }
      : removalRecords
        ? undefined
        : null;
    const request: NativeDetailRequest = { ...input, bytes, removals, id, type: 'native-detail' };
    this.sourceId = args.sourceId;
    this.records = removalRecords;
    return new Promise<NativeDetailPixels>((resolve, reject) => {
      this.pending.set(id, { kind: 'native-detail', resolve, reject });
      try {
        worker.postMessage(request, [
          ...(bytes ? [bytes] : []),
          ...(removals ? [removals.companions] : []),
        ]);
      } catch (error) {
        this.pending.delete(id);
        reject(error);
      }
    }).catch((error) => {
      if (epoch === this.epoch) this.sourceId = null;
      throw error;
    });
  }

  close(retainedWorker: Worker | null = null): void {
    this.epoch++;
    (this.usedWorker ?? retainedWorker)?.postMessage({
      id: this.nextId(),
      type: 'close-native-detail',
    });
    this.sourceId = null;
    this.records = undefined;
    this.usedWorker = null;
  }

  workerFailed(): void {
    this.detach();
  }

  /** Retire tile reuse without freeing the mosaic an active Remove tool owns. */
  detach(): void {
    this.epoch++;
    this.sourceId = null;
    this.records = undefined;
    this.usedWorker = null;
  }
}
