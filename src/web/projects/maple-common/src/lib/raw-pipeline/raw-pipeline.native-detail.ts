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

  render(args: NativeDetailArgs, epoch: number): Promise<NativeDetailPixels> {
    if (epoch !== this.epoch) return Promise.reject(new NativeDetailSupersededError());
    const worker = this.worker();
    this.usedWorker = worker;
    const id = this.nextId();
    const bytes =
      this.sourceId === args.sourceId ? undefined : (args.bytes.slice().buffer as ArrayBuffer);
    const request: NativeDetailRequest = { ...args, bytes, id, type: 'native-detail' };
    this.sourceId = args.sourceId;
    return new Promise<NativeDetailPixels>((resolve, reject) => {
      this.pending.set(id, { kind: 'native-detail', resolve, reject });
      try {
        worker.postMessage(request, bytes ? [bytes] : []);
      } catch (error) {
        this.pending.delete(id);
        reject(error);
      }
    }).catch((error) => {
      if (epoch === this.epoch) this.sourceId = null;
      throw error;
    });
  }

  close(): void {
    this.epoch++;
    this.usedWorker?.postMessage({ id: this.nextId(), type: 'close-native-detail' });
    this.sourceId = null;
    this.usedWorker = null;
  }

  workerFailed(): void {
    this.epoch++;
    this.sourceId = null;
    this.usedWorker = null;
  }
}
