import { NativeDetailSupersededError } from './raw-pipeline.native-detail.types';
import * as wasm from './pkg/raw_wasm';
import { ensureReady } from './raw-pipeline.worker-handlers';
import type { NativeDetailRequest, NativeDetailResponse } from './raw-pipeline.native-detail.types';

interface Patch {
  width: number;
  height: number;
  take_rgb(): Uint8Array;
  free(): void;
}
interface Session {
  render_tile(
    xmp: string | undefined,
    rect: Uint32Array,
    cap: number,
    preview: boolean,
    film: Uint8Array,
  ): Patch;
  free(): void;
}
type SessionCtor = new (bytes: Uint8Array, ext: string) => Session;
interface DetailWorkerDependencies {
  ready(): Promise<unknown>;
  open(bytes: Uint8Array, ext: string): Session;
  post(reply: NativeDetailResponse, transfer?: Transferable[]): void;
}

/** One retained mosaic. Dependencies keep worker lifetime tests browser-free. */
export class NativeDetailWorker {
  private current: { sourceId: string; session: Session } | null = null;
  private epoch = 0;

  constructor(private readonly deps: DetailWorkerDependencies) {}

  close(): void {
    this.epoch++;
    this.current?.session.free();
    this.current = null;
  }

  async render(req: NativeDetailRequest): Promise<void> {
    const generation = this.epoch;
    try {
      await this.deps.ready();
      if (generation !== this.epoch) throw new NativeDetailSupersededError();
      if (this.current?.sourceId !== req.sourceId) {
        this.close();
        if (!req.bytes) throw new Error('Native-detail session unavailable');
        this.current = {
          sourceId: req.sourceId,
          session: this.deps.open(new Uint8Array(req.bytes), req.ext),
        };
      }
      const r = req.rect;
      const patch = this.current.session.render_tile(
        req.xmp,
        new Uint32Array([r.x, r.y, r.width, r.height]),
        req.maxLongEdge,
        req.qualityPreview,
        req.filmLut ? new Uint8Array(req.filmLut) : new Uint8Array(),
      );
      try {
        const rgb = patch.take_rgb();
        const reply: NativeDetailResponse = {
          id: req.id,
          type: 'native-detail-success',
          width: patch.width,
          height: patch.height,
          rgb: rgb.buffer as ArrayBuffer,
        };
        this.deps.post(reply, [reply.rgb]);
      } finally {
        patch.free();
      }
    } catch (error) {
      this.deps.post({
        id: req.id,
        type: 'native-detail-error',
        message: error instanceof Error ? error.message : String(error),
        superseded: error instanceof NativeDetailSupersededError,
      });
    }
  }
}

const worker = new NativeDetailWorker({
  ready: ensureReady,
  open: (bytes, ext) => {
    const ctor = Reflect.get(wasm, 'NativeDetailSession') as SessionCtor | undefined;
    if (!ctor) throw new Error('Native-detail session unavailable');
    return new ctor(bytes, ext);
  },
  post: (reply, transfer = []) => (self as unknown as Worker).postMessage(reply, transfer),
});

export const closeNativeDetail = (): void => worker.close();
export const handleNativeDetail = (request: NativeDetailRequest): Promise<void> =>
  worker.render(request);
